import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, ScrollView, Text, View } from "react-native";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { z } from "zod";
import {
  prepareToolSetup,
  readToolSetup,
  type ToolSetupStatus,
  type apiKeyProvider,
  type setupAction,
} from "../../shared/tool-setup.js";
import { listTools } from "../../shared/tool-catalog.js";
import { readToolActionSettings, saveToolActionSettings } from "../../shared/tool-actions.js";
import { hostRpc } from "../fleet.js";
import { ROW, type HubUi } from "./ui.js";
import type { HubController } from "./controller.js";

const OVERLAY = {
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.5)",
  justifyContent: "center",
  alignItems: "center",
  padding: 24,
} as const;
const CONTENT = { padding: 24, gap: 16 };

async function applySetupSettings(
  serverId: string,
  toolId: string,
  entries: z.infer<typeof prepareToolSetup.output>["settings"] = [],
  preserveExisting: boolean,
) {
  for (const settings of entries) {
    const input = { toolId, action: settings.action };
    const saved = await hostRpc(serverId, readToolActionSettings, input);
    await hostRpc(serverId, saveToolActionSettings, {
      ...input,
      parameters: preserveExisting
        ? { ...settings.parameters, ...saved.parameters }
        : { ...saved.parameters, ...settings.parameters },
    });
  }
  return entries.length > 0;
}

export function ToolSetupDialog({ hub, ui }: { hub: HubController; ui: HubUi }) {
  const selected = hub.setupTarget;
  return selected ? (
    <SetupContent
      key={`${selected.serverId}:${selected.toolId}`}
      hub={hub}
      ui={ui}
      selected={selected}
    />
  ) : null;
}

function SetupContent({
  hub,
  ui,
  selected,
}: {
  hub: HubController;
  ui: HubUi;
  selected: NonNullable<HubController["setupTarget"]>;
}) {
  const { serverId, toolId } = selected;
  const tool = hub.tools.find(
    (item) => item.serverId === serverId && item.tool.id === toolId,
  )?.tool;
  const [status, setStatus] = useState<ToolSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [provider, setProvider] = useState<z.infer<typeof apiKeyProvider>>("openai");
  const alive = useRef(true);
  const latest = useRef(hub);
  latest.current = hub;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const check = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const value = await hostRpc(serverId, readToolSetup, { id: toolId });
      if (!alive.current) return;
      setStatus(value);
      const tools = await hostRpc(serverId, listTools, {});
      if (!alive.current) return;
      latest.current.setTools((items) => [
        ...items.filter((item) => item.serverId !== serverId),
        ...tools.map((entry) => ({ serverId, tool: entry })),
      ]);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [serverId, toolId]);
  useEffect(() => {
    void check();
  }, [check]);
  const perform = async (action: z.infer<typeof setupAction>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const prepared = await hostRpc(serverId, prepareToolSetup, {
        id: toolId,
        action,
        ...(["api-key", "apply-key"].includes(action) ? { provider } : {}),
      });
      if (!alive.current) return;
      const applied = await applySetupSettings(
        serverId,
        toolId,
        prepared.settings,
        action === "install",
      );
      if (!alive.current) return;
      if (applied) latest.current.updatedToolSettings(serverId, toolId);
      const { plan } = prepared;
      if (!plan) {
        if (!prepared.settings?.length)
          throw new Error("Setup returned no configuration or command.");
        setNotice("Native action settings saved on this server. Use in this session to continue.");
        return;
      }
      if (!plan.command) throw new Error("Setup did not return a terminal command.");
      latest.current.rememberSetupReturn(serverId, toolId);
      const api = getPaseoClient(serverId);
      const workspace = await api.workspaces.open({ cwd: plan.cwd });
      const terminal = await api.terminals.create({
        workspaceId: workspace.id,
        cwd: plan.cwd,
        name: `${tool?.name ?? toolId} · ${action}`,
        command: plan.command,
        args: plan.args,
      });
      const instruction =
        "Complete setup in the terminal, then select this tool again and choose Check setup.";
      setNotice(instruction);
      latest.current.setNotice(instruction);
      latest.current.navigation?.openTerminal?.({
        serverId,
        workspaceId: workspace.id,
        terminalId: terminal.id,
      });
      latest.current.setSetupTarget(null);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const close = useCallback(() => {
    if (!busy) hub.setSetupTarget(null);
  }, [busy, hub]);
  const dialogStyle = useMemo(
    () => ({
      maxWidth: 720,
      width: "100%" as const,
      maxHeight: "90%" as const,
      backgroundColor: ui.colors.surface1,
      borderRadius: 12,
    }),
    [ui.colors.surface1],
  );
  const continueSession = () => {
    hub.setTarget(serverId);
    hub.setToolId(toolId);
    hub.setSetupTarget(null);
    const destination = tool?.nativeProvider ? "Sessions" : "Tools";
    hub.setTab(selected.returnTab === "Inputs / Results" ? selected.returnTab : destination);
    hub.setNotice(
      `${tool?.name ?? toolId} selected for ${hub.session?.title ?? "this session"} on ${hub.hostName(serverId)}. ${tool?.nativeProvider ? "Choose a model and start or continue." : "Choose a native action or open its original interface below."}`,
    );
  };
  return (
    <Modal transparent visible animationType="fade" onRequestClose={close}>
      <View style={OVERLAY}>
        <ScrollView style={dialogStyle} contentContainerStyle={CONTENT}>
          <Text style={ui.sectionHeading}>Set up {tool?.name ?? toolId}</Text>
          <Text style={ui.text}>
            {hub.hostName(serverId)} ·{" "}
            {hub.session?.title ?? "Your current project and session will be kept"}
          </Text>
          <Text style={ui.muted}>
            Install here, complete the original sign-in, then return to your session. Credentials
            stay on this server.
          </Text>
          {busy ? <Text style={ui.text}>Checking / opening setup…</Text> : null}
          {status ? (
            <>
              <Text style={ui.text}>{status.message}</Text>
              <Text style={ui.muted}>
                Installation: {status.installation} · Account: {status.account.replaceAll("-", " ")}
              </Text>
              {status.details.map((detail) => (
                <Text key={detail} style={ui.muted}>
                  {detail}
                </Text>
              ))}
              {status.actions.some((action) => action.id === "api-key") ? (
                <>
                  <Text style={ui.text}>API provider</Text>
                  <View style={ROW}>
                    {(["openai", "anthropic", "openrouter"] as const).map((id) => (
                      <View key={id}>
                        {ui.button(id, () => setProvider(id), busy, provider === id)}
                      </View>
                    ))}
                  </View>
                  <Text style={ui.muted}>
                    Paste the key only in the hidden-input terminal. No key is stored in chat or
                    action settings.
                  </Text>
                </>
              ) : null}
              <View style={ROW}>
                {status.actions.map((action) => (
                  <View key={action.id}>
                    {ui.button(
                      action.label,
                      () => {
                        void perform(action.id);
                      },
                      busy,
                    )}
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={ui.error}>
              {error}
            </Text>
          ) : null}
          {notice ? <Text style={ui.text}>{notice}</Text> : null}
          <View style={ROW}>
            {ui.button(
              "Check setup",
              () => {
                void check();
              },
              busy,
            )}
            {ui.button(
              "Use in this session",
              continueSession,
              busy || status?.installation !== "installed" || status.account === "sign-in-required",
            )}
            {tool
              ? ui.button(
                  "Ask agent to set up",
                  () => {
                    close();
                    void hub.run(() => hub.askSetup(serverId, tool));
                  },
                  busy || !hub.cwd,
                )
              : null}
            {ui.button("Close", close, busy)}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
