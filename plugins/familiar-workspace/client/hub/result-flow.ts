import { useEffect, useRef, useState } from "react";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import type { output } from "zod";
import {
  captureCompositionResult,
  listCompositionInputs,
  prepareCompositionInput,
  previewCompositionResult,
  readCompositionResult,
  reconcileCompositionInput,
  sendCompositionInput,
  type CompositionInput,
  type CompositionResult,
} from "../../shared/results.js";
import { RESULT_INSTRUCTION_BYTE_LIMIT } from "../../shared/result-selection.js";
import { type CompositionSession } from "../../shared/composition.js";
import { connectContextSources, hostRpc, operationId } from "../fleet.js";
import {
  bindResultTarget,
  ensureResultSession,
  findResultSession,
  loadResultDraft,
  parseResultRoute,
  type ResultDraft,
} from "./result-actions.js";
import type { HubController, NativeTargetSelection } from "./controller.js";

interface InputRecord {
  result: CompositionResult;
  input: CompositionInput;
}
export const INPUT_PAGE_SIZE = 30;
export const nativeTargetKey = (serverId: string, agentId: string) =>
  JSON.stringify([serverId, agentId]);
function targetCoordinates(key: string) {
  const value: unknown = JSON.parse(key);
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((part) => typeof part === "string" && part)
  )
    throw new Error("Choose a target conversation.");
  return { serverId: value[0] as string, agentId: value[1] as string };
}
export function useResultFlow(
  hub: HubController,
  entryHostId: string,
  params?: Record<string, string>,
) {
  const latest = useRef(hub);
  latest.current = hub;
  const [draft, setDraft] = useState<ResultDraft | null>(null);
  const [manual, setManual] = useState<{
    serverId: string;
    agentId: string;
    text: string | null;
    reason: string;
  } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [targetKey, setTargetKey] = useState("new");
  const [submitted, setSubmitted] = useState<InputRecord | null>(null);
  const [deliveryError, setDeliveryError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState<ReadonlySet<string>>(new Set());
  const [records, setRecords] = useState<output<typeof listCompositionInputs.output>>({
    records: [],
    total: 0,
  });
  const [offset, setOffset] = useState(0),
    [version, setVersion] = useState(0);
  const [expanded, setExpanded] = useState<{ resultId: string; text: string } | null>(null);
  const sending = useRef(false);
  const submittedId = useRef<string | null>(null);
  const preparation = useRef<{ key: string; id: string } | null>(null);
  const targetCreation = useRef<{
    sessionId: string;
    id: string;
    selection: NativeTargetSelection;
  } | null>(null);
  const [pendingTarget, setPendingTarget] = useState<NativeTargetSelection | null>(null);
  const resultAgentId = params?.resultAgentId;
  const resultSelection = params?.resultSelection;
  const catalog = hub.host.id;
  useEffect(() => {
    if (!resultAgentId || !resultSelection) return;
    let cancelled = false;
    const current = latest.current;
    void current.run(async () => {
      const route = parseResultRoute({ resultAgentId, resultSelection });
      if (!route) return;
      setDraft(null);
      setManual(null);
      setSubmitted(null);
      submittedId.current = null;
      preparation.current = null;
      targetCreation.current = null;
      setPendingTarget(null);
      setDeliveryError("");
      setInstruction("");
      let next: ResultDraft;
      try {
        next = await loadResultDraft(catalog, entryHostId, route);
      } catch (error) {
        let text: string | null = null;
        let reason = error instanceof Error ? error.message : String(error);
        try {
          text = (await hostRpc(entryHostId, previewCompositionResult, route)).text;
        } catch (previewError) {
          reason += ` Preview unavailable: ${previewError instanceof Error ? previewError.message : String(previewError)}`;
        }
        if (!cancelled) {
          setManual({ serverId: entryHostId, agentId: route.agentId, text, reason });
          current.setProject(null);
          current.setSession(null);
          current.setTab("Inputs / Results");
        }
        return;
      }
      if (cancelled) return;
      setDraft(next);
      current.setProject(next.project);
      current.setSession(next.session);
      current.setTitle(next.session?.title ?? next.source.title ?? "Session");
      current.setMemory(next.session?.memory ?? "");
      const destination = next.session?.endpoints.findLast(
        (endpoint) =>
          endpoint.kind === "agent" &&
          !(endpoint.serverId === entryHostId && endpoint.agentId === next.source.id),
      );
      setTargetKey(
        destination ? nativeTargetKey(destination.serverId, destination.agentId) : "new",
      );
      current.setTarget(destination?.serverId ?? entryHostId);
      current.setCwd(destination?.cwd ?? next.source.cwd);
      current.setTab("Inputs / Results");
    });
    return () => {
      cancelled = true;
    };
    // Only a new source route starts a capture; Hub state changes must not recapture or create data.
  }, [resultAgentId, resultSelection, catalog, entryHostId]);

  const sessionId = hub.session?.id;
  useEffect(() => {
    setOffset(0);
    setExpanded(null);
  }, [sessionId]);
  useEffect(() => {
    let active = true;
    setRecords({ records: [], total: 0 });
    if (!sessionId || hub.tab !== "Inputs / Results") return;
    void hostRpc(catalog, listCompositionInputs, { id: sessionId, offset, limit: INPUT_PAGE_SIZE })
      .then((value) => {
        if (active) setRecords(value);
        return;
      })
      .catch((error: unknown) => {
        if (active) latest.current.fail(error);
      });
    return () => {
      active = false;
    };
  }, [catalog, sessionId, hub.tab, offset, version]);

  const updateSession = (value: CompositionSession) => {
    hub.setSession(value);
    hub.setTitle(value.title);
    hub.setMemory(value.memory);
    setDraft((previous) => (previous ? { ...previous, session: value } : null));
  };
  const resolveTarget = async (
    value: CompositionSession,
    project: NonNullable<ResultDraft["project"]>,
  ) => {
    if (targetKey !== "new") {
      const coords = targetCoordinates(targetKey);
      const current = await getPaseoClient(coords.serverId).agents.ref(coords.agentId).refresh();
      if (!current) throw new Error("The target conversation is no longer available.");
      return bindResultTarget(catalog, value, coords.serverId, current.agent, hub.hosts);
    }
    if (!targetCreation.current) {
      const chosen = hub.nativeTargetSelection();
      const selection = { ...chosen, title: chosen.title.trim() || value.title };
      targetCreation.current = { sessionId: value.id, id: operationId(), selection };
      setPendingTarget(selection);
    }
    if (targetCreation.current.sessionId !== value.id)
      throw new Error(
        "The shared session changed. Cancel this input before choosing another target.",
      );
    const created = await hub.createNativeTarget(project, value, {
      resultInput: true,
      idempotencyKey: targetCreation.current.id,
      selection: targetCreation.current.selection,
    });
    const endpoint = created.session.endpoints.find(
      (item) =>
        item.serverId === targetCreation.current!.selection.serverId &&
        item.agentId === created.handle.id,
    );
    if (!endpoint) throw new Error("The new target could not be found. Reload the shared session.");
    setTargetKey(nativeTargetKey(endpoint.serverId, endpoint.agentId));
    return { session: created.session, endpoint };
  };
  const validateDestination = async (selected: ResultDraft) => {
    if (
      targetKey === "new" &&
      !targetCreation.current &&
      (!hub.selectedTool?.nativeProvider || !hub.modelId || !hub.cwd.trim())
    )
      throw new Error("Choose a target server, project folder, native agent and model.");
    if (targetKey !== "new") {
      const coords = targetCoordinates(targetKey);
      if (coords.serverId === selected.sourceServerId && coords.agentId === selected.source.id)
        throw new Error("Choose a different conversation as the target.");
      const linked = await findResultSession(catalog, coords.serverId, coords.agentId);
      if (linked && linked.session.id !== selected.session?.id)
        throw new Error("This target belongs to another shared session. Choose New agent instead.");
    }
  };
  const send = async () => {
    if (!draft || submittedId.current || sending.current) return;
    sending.current = true;
    try {
      if (new TextEncoder().encode(instruction).length > RESULT_INSTRUCTION_BYTE_LIMIT)
        throw new Error("The instruction is too long. Shorten it before sending.");
      await validateDestination(draft);
      // Validate the selection before the explicit send creates any session or target.
      await hostRpc(draft.sourceServerId, captureCompositionResult, {
        agentId: draft.source.id,
        selection: draft.selection,
      });
      const linked = await ensureResultSession(catalog, draft, hub.hosts);
      hub.setProject(linked.project);
      updateSession(linked.session);
      const target = await resolveTarget(linked.session, linked.project);
      updateSession(target.session);
      const destination = hub.hosts.find((item) => item.serverId === target.endpoint.serverId);
      await connectContextSources(catalog, target.session, destination, hub.hosts);
      const source = target.session.endpoints.find(
        (item) =>
          item.serverId === draft.sourceServerId &&
          item.agentId === draft.source.id &&
          item.kind === "agent",
      );
      if (!source) throw new Error("The source endpoint is no longer linked to this session.");
      const key = JSON.stringify([
        target.session.id,
        source.id,
        target.endpoint.id,
        draft.capture.anchor,
        instruction,
      ]);
      if (preparation.current?.key !== key) preparation.current = { key, id: operationId() };
      const prepared = await hostRpc(catalog, prepareCompositionInput, {
        id: target.session.id,
        expectedRevision: target.session.revision,
        operationId: preparation.current.id,
        sourceEndpointId: source.id,
        anchor: draft.capture.anchor,
        targetEndpointId: target.endpoint.id,
        instruction,
      });
      setSubmitted(prepared);
      submittedId.current = prepared.input.id;
      setDeliveryError("");
      try {
        const receipt = await hostRpc(target.endpoint.serverId, sendCompositionInput, {
          id: target.session.id,
          inputId: prepared.input.id,
        });
        setSubmitted(receipt);
      } catch (error) {
        setUnconfirmed((previous) => new Set(previous).add(prepared.input.id));
        setDeliveryError(
          `Delivery was not confirmed. Check status or open the target; this input will not be automatically resent. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      setVersion((current) => current + 1);
      await hub.refresh();
    } finally {
      sending.current = false;
    }
  };
  const check = async (record: InputRecord) => {
    const value = await hostRpc(record.input.targetServerId, reconcileCompositionInput, {
      id: record.input.sessionId,
      inputId: record.input.id,
    });
    if (submitted?.input.id === value.input.id) {
      setSubmitted(value);
      setDeliveryError("");
    }
    setUnconfirmed((previous) => {
      const next = new Set(previous);
      next.delete(record.input.id);
      return next;
    });
    setVersion((current) => current + 1);
  };
  const sendPrepared = async (record: InputRecord) => {
    if (record.input.state !== "prepared" || unconfirmed.has(record.input.id) || sending.current)
      return;
    sending.current = true;
    try {
      const value = await hostRpc(record.input.targetServerId, sendCompositionInput, {
        id: record.input.sessionId,
        inputId: record.input.id,
      });
      if (submitted?.input.id === value.input.id) setSubmitted(value);
      setVersion((current) => current + 1);
    } catch (error) {
      setUnconfirmed((previous) => new Set(previous).add(record.input.id));
      if (submitted?.input.id === record.input.id)
        setDeliveryError("Delivery is uncertain. Check status before attempting another input.");
      throw error;
    } finally {
      sending.current = false;
    }
  };
  const preview = async (record: InputRecord) => {
    const value = await hostRpc(catalog, readCompositionResult, {
      id: record.result.sessionId,
      resultId: record.result.id,
    });
    setExpanded({ resultId: value.result.id, text: value.text });
  };
  const copy = async () => {
    const text = draft?.capture.text ?? manual?.text;
    if (text == null) throw new Error("Open the original conversation to copy this response.");
    await copyText([instruction.trim(), text].filter(Boolean).join("\n\n"));
    hub.setNotice("Input copied. Paste it into the original tool. No delivery has been recorded.");
  };
  const cancel = () => {
    setDraft(null);
    setManual(null);
    setSubmitted(null);
    submittedId.current = null;
    preparation.current = null;
    targetCreation.current = null;
    setPendingTarget(null);
    setDeliveryError("");
  };
  return {
    draft,
    manual,
    instruction,
    setInstruction,
    targetKey,
    pendingTarget,
    setTargetKey,
    submitted,
    deliveryError,
    unconfirmed,
    records,
    offset,
    setOffset,
    expanded,
    send,
    check,
    sendPrepared,
    preview,
    copy,
    cancel,
    refresh: () => setVersion((current) => current + 1),
  };
}
export type ResultFlow = ReturnType<typeof useResultFlow>;
