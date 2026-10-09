import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { z } from "zod";
import {
  captureCompositionResult,
  previewCompositionResult,
  prepareCompositionInput,
  readCompositionInput,
  readCompositionResult,
  listCompositionInputs,
  claimCompositionInput,
  finishCompositionInput,
  sendCompositionInput,
  reconcileCompositionInput,
  type ResultAnchor,
  type CompositionInput,
} from "../../shared/results.js";
import { RESULT_TEXT_BYTE_LIMIT } from "../../shared/result-selection.js";
import { captureResult, previewResult } from "./result-source.js";
import { joinSelectedText, renderResultInput, textDigest } from "./result-text.js";
import type { ResourceReader } from "./store.js";
import type { ToolActions } from "../tool-actions/service.js";
import type { ResultStore } from "./result-store.js";

export const resultCatalogContracts = [
  prepareCompositionInput,
  readCompositionInput,
  readCompositionResult,
  listCompositionInputs,
  claimCompositionInput,
  finishCompositionInput,
];

export async function resolveResultText(anchor: ResultAnchor, reader: ResourceReader) {
  const page = await reader(anchor.resource, {
    offset: 0,
    limit: anchor.selection.segments.length,
    maxCharacters: RESULT_TEXT_BYTE_LIMIT,
    selection: anchor.selection,
  });
  if (page.truncated) throw new Error("Selected source response cannot be truncated into an input");
  return joinSelectedText(page.messages, anchor.selection);
}

export async function invokeResultCatalog(
  store: ResultStore,
  reader: ResourceReader,
  method: string,
  raw: unknown,
) {
  switch (method) {
    case prepareCompositionInput.name: {
      const input = prepareCompositionInput.input.parse(raw);
      const previous = store.replay(input);
      const anchor = previous?.result.anchor ?? store.plan(input);
      const selected = await resolveResultText(anchor, reader);
      const record = store.prepare(input, selected);
      return {
        ...record,
        text: renderResultInput(record.result.anchor, selected, record.input.instruction),
      };
    }
    case readCompositionInput.name: {
      const input = readCompositionInput.input.parse(raw);
      return store.read(input.id, input.inputId);
    }
    case readCompositionResult.name: {
      const input = readCompositionResult.input.parse(raw);
      const result = store.result(input.id, input.resultId);
      return { result, text: await resolveResultText(result.anchor, reader) };
    }
    case listCompositionInputs.name: {
      const input = listCompositionInputs.input.parse(raw);
      return store.list(input.id, input.offset, input.limit);
    }
    case claimCompositionInput.name: {
      const input = claimCompositionInput.input.parse(raw);
      return store.claim(input.id, input.inputId, input.targetServerId);
    }
    case finishCompositionInput.name:
      return store.finish(finishCompositionInput.input.parse(raw));
    default:
      throw new Error("Unknown result catalog action");
  }
}

function failureText(error: unknown) {
  return (error instanceof Error ? error.message : "Result input could not be delivered").slice(
    0,
    2000,
  );
}
function wasRejected(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "deliveryState" in error &&
    error.deliveryState === "rejected"
  );
}

export function registerResultHandlers(
  server: PluginServerContext,
  options: {
    serverId: string;
    actions?: ToolActions;
    invoke: (method: string, input: Record<string, unknown>, paseo?: PaseoApi) => Promise<unknown>;
    reader: (paseo: PaseoApi) => ResourceReader;
  },
) {
  const register = <I extends z.ZodType, O extends z.ZodType>(contract: PluginRpcContract<I, O>) =>
    server.handle(
      contract,
      async (input, { paseo }) =>
        contract.output.parse(
          await options.invoke(contract.name, input as Record<string, unknown>, paseo),
        ) as z.input<O>,
    );
  register(prepareCompositionInput);
  register(readCompositionInput);
  register(readCompositionResult);
  register(listCompositionInputs);
  register(claimCompositionInput);
  register(finishCompositionInput);
  server.handle(captureCompositionResult, (input, { paseo }) =>
    captureResult(paseo, options.serverId, input.agentId, input.selection),
  );
  server.handle(previewCompositionResult, (input, { paseo }) =>
    previewResult(paseo, input.agentId, input.selection),
  );
  const deliver = async (id: string, inputId: string, paseo: PaseoApi, reconcile: boolean) => {
    const record = readCompositionInput.output.parse(
      await options.invoke(readCompositionInput.name, { id, inputId }, paseo),
    );
    if (record.input.targetServerId !== options.serverId)
      throw new Error("Open the selected target server before sending this input");
    if (deliveryIsSettled(record.input, reconcile)) return record;
    if (!reconcile && record.input.state !== "prepared") return record;
    const claim = claimCompositionInput.output.parse(
      await options.invoke(
        claimCompositionInput.name,
        { id, inputId, targetServerId: options.serverId },
        paseo,
      ),
    );
    if (!reconcile && !claim.claimed) return { input: claim.input, result: claim.result };
    if (!claim.token) return record;
    let nativeInvoked = false;
    let state: CompositionInput["state"] = "unknown";
    let error: string | null = null;
    try {
      const selected = await resolveResultText(record.result.anchor, options.reader(paseo));
      const prompt = renderResultInput(record.result.anchor, selected, record.input.instruction);
      if (textDigest(prompt).sha256 !== record.input.inputSha256)
        throw new Error("Prepared result input no longer matches its recorded digest");
      if (record.input.tool) {
        if (!options.actions)
          throw new Error("Native tool execution is unavailable on this server");
        nativeInvoked = true;
        const delivered = await deliverToolInput(options.actions, record.input, prompt, reconcile);
        state = delivered.state;
        error = delivered.error;
      } else {
        const agent = paseo.agents.ref(record.input.targetAgentId);
        if (reconcile) {
          const receipt = await agent.messageReceipt(inputId, {
            text: prompt,
            activeTurnBehavior: "reject",
          });
          if (receipt.state === "completed") state = "accepted";
          else if (receipt.state === "rejected") state = "failed";
          error = receipt.error;
        } else {
          nativeInvoked = true;
          await agent.send(prompt, { messageId: inputId, activeTurnBehavior: "reject" });
          state = "accepted";
        }
      }
    } catch (failure) {
      state = !reconcile && (!nativeInvoked || wasRejected(failure)) ? "failed" : "unknown";
      error = failureText(failure);
    }
    try {
      return finishCompositionInput.output.parse(
        await options.invoke(
          finishCompositionInput.name,
          {
            id,
            inputId,
            token: claim.token,
            targetServerId: options.serverId,
            targetAgentId: record.input.targetAgentId,
            state,
            error,
          },
          paseo,
        ),
      );
    } catch (failure) {
      // Native execution may have started; a missing catalog ACK must never trigger another send.
      return {
        result: record.result,
        input: {
          ...claim.input,
          state: "unknown" as const,
          error: `Delivery receipt could not be saved: ${failureText(failure)}`.slice(0, 2000),
        },
      };
    }
  };
  server.handle(sendCompositionInput, (input, { paseo }) =>
    deliver(input.id, input.inputId, paseo, false),
  );
  server.handle(reconcileCompositionInput, (input, { paseo }) =>
    deliver(input.id, input.inputId, paseo, true),
  );
}

async function deliverToolInput(
  actions: ToolActions,
  input: CompositionInput,
  prompt: string,
  reconcile: boolean,
): Promise<{ state: CompositionInput["state"]; error: string | null }> {
  if (!input.tool) throw new Error("Missing native action descriptor");
  const request = { ...input.tool, sessionId: input.sessionId, input: prompt };
  const run = reconcile
    ? actions.store.replay(input.id, request)
    : await actions.start({ ...request, operationId: input.id });
  if (!run)
    throw new Error(
      "No native action receipt is available for this input. Inspect the original target; it was not resent.",
    );
  let state: CompositionInput["state"] = "unknown";
  if (run.state === "completed" || run.state === "submitted") state = "accepted";
  else if (run.state === "failed") state = "failed";
  const error =
    run.error ??
    (run.state === "running"
      ? "Native action is running. Check status to read its receipt."
      : null);
  return { state, error };
}

function deliveryIsSettled(input: CompositionInput, reconcile: boolean) {
  return (
    input.state === "accepted" ||
    input.state === "failed" ||
    (reconcile && input.state === "prepared")
  );
}
