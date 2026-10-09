import { readWithDeadline } from "../read-deadline.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { ToolEntry } from "../../shared/tool-catalog.js";
import { readToolSetup, type ToolSetupStatus } from "../../shared/tool-setup.js";
import { hostRpc } from "../fleet.js";
import type { HubController } from "./controller.js";
import { HubPicker, ROW, type HubUi } from "./ui.js";
import { ToolGuide } from "./tool-guide.js";
import { SetupAgentPicker } from "./setup-agent.js";
import {
  readSetupDraft,
  saveSetupDraft,
  setupReadiness,
  type SetupDraft,
} from "./onboarding-state.js";

const PROVIDERS = ["codex", "claude"];
const CARD_HEADER = {
  flexDirection: "row",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
} as const;
const CHECKBOX = {
  flex: 1,
  flexDirection: "row",
  alignItems: "center",
  gap: 10,
  minHeight: 40,
} as const;
const NEXT = { alignItems: "flex-end", paddingTop: 10 } as const;
interface SetupEngine {
  serverId: string;
  provider: string;
}
const OVERLAY = {
  flex: 1,
  backgroundColor: "rgba(0,0,0,0.5)",
  justifyContent: "center",
  alignItems: "center",
  padding: 16,
} as const;
const CONTENT = { padding: 20, gap: 14 };
interface Check {
  id: string;
  status?: ToolSetupStatus;
  error?: string;
}

/** At most two read-only checks run together; each result is usable immediately. */
async function checkTools(
  serverId: string,
  ids: string[],
  current: () => boolean,
  progress?: (values: Check[]) => void,
): Promise<Check[]> {
  const results: Check[] = [];
  for (let index = 0; index < ids.length && current(); index += 2) {
    await Promise.all(
      ids.slice(index, index + 2).map(async (id) => {
        try {
          const status = await readWithDeadline(
            hostRpc(serverId, readToolSetup, { id }),
            `${id} status`,
          );
          results.push({ id, status });
        } catch (error) {
          results.push({ id, error: error instanceof Error ? error.message : String(error) });
        }
        if (current()) progress?.([...results]);
      }),
    );
  }
  return results;
}

export function useOnboarding(hub: HubController, explicitEntry = false) {
  const [saved] = useState(() => readSetupDraft(hub.host.id));
  const [visible, setVisible] = useState(Boolean(saved && !saved.dismissed));
  const probe = useRef(0);
  const [draft, setDraft] = useState<SetupDraft>(
    saved ?? {
      serverId: hub.target,
      toolIds: [],
      step: 1,
      dismissed: false,
    },
  );
  const checked = useRef(false);
  const [setupEngine, setSetupEngine] = useState<SetupEngine>();
  const update = useCallback(
    (value: Partial<SetupDraft>) => {
      setDraft((previous) => {
        const next = { ...previous, ...value };
        saveSetupDraft(hub.host.id, next);
        return next;
      });
    },
    [hub.host.id],
  );
  const open = useCallback(() => {
    probe.current++;
    checked.current = true;
    setVisible(true);
    update({ dismissed: false });
  }, [update]);
  const close = useCallback(() => {
    probe.current++;
    checked.current = true;
    setVisible(false);
    update({ dismissed: true });
  }, [update]);
  // Never interrupt an existing workspace or explicit current-conversation/tool entry.
  const eligible =
    hub.catalogLoaded &&
    !hub.projects.length &&
    !hub.catalogTotal &&
    !hub.session &&
    !explicitEntry;
  const onlineKey = JSON.stringify(hub.online.map((host) => host.serverId).sort());
  const latest = useRef(hub);
  latest.current = hub;
  useEffect(() => {
    if (!eligible || checked.current || saved?.dismissed) return;
    let current = true;
    const version = probe.current;
    void (async () => {
      for (const host of latest.current.online) {
        const statuses = await checkTools(
          host.serverId,
          PROVIDERS,
          () => current && probe.current === version,
        );
        if (!current || probe.current !== version) return;
        const ready = statuses.find(
          (item) =>
            item.status?.installation === "installed" && item.status.account === "signed-in",
        );
        if (ready) {
          setSetupEngine({ serverId: host.serverId, provider: ready.id });
          checked.current = true;
          update({ serverId: host.serverId, step: 2 });
          setVisible(true);
          return;
        }
      }
      if (current && probe.current === version) {
        checked.current = true;
        setVisible(true);
      }
    })();
    return () => {
      current = false;
    };
  }, [eligible, saved?.dismissed, onlineKey, update]);
  return { visible, draft, update, open, close, setupEngine };
}
export type OnboardingState = Omit<ReturnType<typeof useOnboarding>, "setupEngine"> & {
  setupEngine?: SetupEngine;
};

export function HubOnboarding({
  hub,
  ui,
  state,
}: {
  hub: HubController;
  ui: HubUi;
  state: OnboardingState;
}) {
  const { draft, update } = state;
  const [checkResults, setChecks] = useState<Check[]>([]);
  const [checkedScope, setCheckedScope] = useState("");
  const [engines, setEngines] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const dialog = useMemo(
    () => ({
      backgroundColor: ui.colors.surface0,
      width: "100%" as const,
      maxWidth: 680,
      maxHeight: "90%" as const,
      borderRadius: 12,
    }),
    [ui.colors.surface0],
  );
  const options = useMemo(
    () =>
      hub.hosts.map((host) => ({
        id: host.serverId,
        label: host.label,
        disabled: host.status !== "online",
      })),
    [hub.hosts],
  );
  const catalog = useMemo(
    () => hub.tools.filter((item) => item.serverId === draft.serverId).map((item) => item.tool),
    [hub.tools, draft.serverId],
  );
  const selected = useMemo(
    () => catalog.filter((tool) => draft.toolIds.includes(tool.id)),
    [catalog, draft.toolIds],
  );
  let checkIds: string[] = [];
  if (draft.step === 1) checkIds = PROVIDERS;
  if (draft.step === 4) checkIds = draft.toolIds;
  const checkKey = JSON.stringify(checkIds);
  const scope = `${draft.serverId}:${checkKey}`;
  const checks = checkedScope === scope ? checkResults : [];
  const selectedProvider = chosenSetupEngine(engines, draft.serverId, state.setupEngine);
  const active = state.visible && !hub.setupTarget;
  const online = hub.online.some((host) => host.serverId === draft.serverId);
  useEffect(() => {
    let current = true;
    const ids = JSON.parse(checkKey) as string[];
    setChecks([]);
    setCheckedScope(scope);
    if (!active || !online || !ids.length) {
      setBusy(false);
      return;
    }
    setBusy(true);
    void checkTools(draft.serverId, ids, () => current, setChecks)
      .then((value) => {
        if (current) setChecks(value);
        return undefined;
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [draft.serverId, checkKey, revision, active, online, scope]);
  const readyProviders = checks.filter(
    (item) => item.status?.installation === "installed" && item.status.account === "signed-in",
  );
  const signedIn = readyProviders.length > 0;
  const chooseProvider = (provider: string) =>
    setEngines((previous) => ({ ...previous, [draft.serverId]: provider }));
  const continueToTools = () => {
    const provider =
      readyProviders.find((item) => item.id === selectedProvider)?.id ?? readyProviders[0]?.id;
    if (provider) {
      chooseProvider(provider);
      update({ step: 2 });
    }
  };
  const checkAgain = useCallback(() => setRevision((value) => value + 1), []);
  const requested = useCallback((serverId: string) => update({ serverId, step: 4 }), [update]);
  const selectServer = useCallback(
    (serverId: string) => {
      if (serverId !== draft.serverId)
        update({ serverId, toolIds: [], step: Math.min(draft.step, 2) });
    },
    [draft.serverId, draft.step, update],
  );
  const retryCatalog = useCallback(() => {
    void hub.reloadTools(draft.serverId);
  }, [hub, draft.serverId]);
  const chooseTool = (id: string) => {
    hub.useSetupTool(draft.serverId, id);
    state.close();
  };
  if (!active) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={state.close}>
      <View style={OVERLAY}>
        <ScrollView style={dialog} contentContainerStyle={CONTENT}>
          <Text style={ui.heading}>Set up your tools</Text>
          <Text style={ui.muted}>
            Step {draft.step} of 4 · Connect an account, choose tools, delegate setup, then check.
          </Text>
          <HubPicker
            label="Installation server"
            value={draft.serverId}
            options={options}
            onChange={selectServer}
            ui={ui}
          />
          {!online ? (
            <Text style={ui.error}>Reconnect this server or choose an online server.</Text>
          ) : null}
          {draft.step === 1 ? (
            <>
              <Text style={ui.sectionHeading}>1. Connect Codex or Claude Code</Text>
              <Text style={ui.text}>
                Use an existing account on this server. Supported tools reuse it through their
                native adapters; credentials stay on the original server.
              </Text>
              {PROVIDERS.map((id) => {
                const ready = readyProviders.some((item) => item.id === id);
                const name = id === "codex" ? "Codex" : "Claude Code";
                const selectedEngine = selectedProvider === id;
                return (
                  <View key={id} style={ui.card}>
                    <Text style={ui.text}>{name}</Text>
                    <SetupCheck check={checks.find((item) => item.id === id)} ui={ui} />
                    {ui.button(
                      ready
                        ? `${selectedEngine ? "Selected" : "Select"} ${name}`
                        : `Connect ${name}`,
                      () => (ready ? chooseProvider(id) : hub.openSetup(draft.serverId, id)),
                      !online,
                      ready && selectedEngine,
                    )}
                  </View>
                );
              })}
              {ui.button("Check connection", checkAgain, busy || !online)}
              {ui.button("Continue to choose tools", continueToTools, !signedIn)}
            </>
          ) : null}
          {draft.step === 2 ? (
            <ChooseTools
              ui={ui}
              catalog={catalog}
              selected={selected}
              draft={draft}
              update={update}
              online={online}
              catalogError={hub.toolCatalogErrors?.[draft.serverId]}
              loading={catalogIsLoading(hub, draft.serverId)}
              retry={retryCatalog}
            />
          ) : null}
          {draft.step === 3 ? (
            <>
              <Text style={ui.sectionHeading}>3. Delegate setup</Text>
              <Text style={ui.text}>{setupSummary(selected) || "Choose tools first."}</Text>
              <Text style={ui.muted}>
                One explicit request asks the selected agent to set up every selected tool. It
                checks existing installations, preserves accounts, and reports any login that needs
                you.
              </Text>
              {selected[0] ? (
                <SetupAgentPicker
                  key={draft.serverId}
                  hub={hub}
                  ui={ui}
                  tool={selected[0]}
                  tools={selected}
                  serverId={draft.serverId}
                  preferredProvider={selectedProvider}
                  onRequested={requested}
                />
              ) : null}
              {ui.button(
                "I already set these up — check now",
                () => update({ step: 4 }),
                !selected.length || selected.length !== draft.toolIds.length || !online,
              )}
            </>
          ) : null}
          {draft.step === 4 ? (
            <>
              <Text style={ui.sectionHeading}>4. Check and use</Text>
              <Text style={ui.muted}>
                Installation and account checks are separate. These checks do not prove a model turn
                or every feature works. Follow the setup agent for its verification and any
                remaining login.
              </Text>
              {draft.toolIds.map((id) => (
                <View key={id} style={ui.card}>
                  <Text style={ui.text}>{catalog.find((tool) => tool.id === id)?.name ?? id}</Text>
                  <SetupCheck check={checks.find((item) => item.id === id)} ui={ui} />
                  <View style={ROW}>
                    {ui.button(
                      "Finish setup / sign in",
                      () => hub.openSetup(draft.serverId, id),
                      !online,
                    )}
                    {ui.button(
                      `Use ${catalog.find((tool) => tool.id === id)?.name ?? id}`,
                      () => chooseTool(id),
                      !online ||
                        !checks.find((item) => item.id === id)?.status ||
                        checks.find((item) => item.id === id)?.status?.installation !==
                          "installed" ||
                        checks.find((item) => item.id === id)?.status?.account ===
                          "sign-in-required",
                    )}
                  </View>
                </View>
              ))}
              {ui.button(busy ? "Checking setup…" : "Check setup", checkAgain, busy || !online)}
              {ui.button("Done for now", state.close)}
            </>
          ) : null}
          <View style={ROW}>
            {draft.step > 1 ? ui.button("Back", () => update({ step: draft.step - 1 })) : null}
            {ui.button("Close — continue later", state.close)}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
function SetupCheck({ check, ui }: { check?: Check; ui: HubUi }) {
  if (!check) return <Text style={ui.muted}>Not checked yet</Text>;
  if (!check.status) return <Text style={ui.error}>{check.error || "Status unavailable"}</Text>;
  return (
    <>
      <Text style={ui.text}>{setupReadiness(check.status)}</Text>
      <Text style={ui.muted}>{check.status.message}</Text>
    </>
  );
}

function ChooseTools({
  ui,
  catalog,
  selected,
  draft,
  update,
  online,
  catalogError,
  loading,
  retry,
}: {
  ui: HubUi;
  catalog: ToolEntry[];
  selected: ToolEntry[];
  draft: SetupDraft;
  update: OnboardingState["update"];
  online: boolean;
  catalogError?: string;
  loading: boolean;
  retry: () => void;
}) {
  const eligible = catalog.filter((tool) => !tool.installed && canSetUp(tool));
  const selectedUninstalled = selected.filter((tool) => !tool.installed && canSetUp(tool));
  const availableSelections = selected.filter((tool) => tool.installed || canSetUp(tool));
  const hasUnavailableSelection = availableSelections.length !== draft.toolIds.length;
  const allSelected = eligible.every((tool) => draft.toolIds.includes(tool.id));
  const batch = catalog.filter((tool) => tool.installed || selectedUninstalled.includes(tool));
  const toggleTool = useCallback(
    (id: string) =>
      update({
        toolIds: draft.toolIds.includes(id)
          ? draft.toolIds.filter((value) => value !== id)
          : [...draft.toolIds, id],
      }),
    [draft.toolIds, update],
  );
  return (
    <>
      <Text style={ui.sectionHeading}>2. Choose your tools</Text>
      <Text style={ui.muted}>
        Choose tools to install. Installed tools are included for connection checks only; the setup
        agent preserves their original installation and configures them only if needed.
      </Text>
      {hasUnavailableSelection ? (
        <View>
          <Text style={ui.error}>
            Some selected tools are unavailable or need setup instructions on this server.
          </Text>
          {ui.button("Remove unavailable selections", () =>
            update({ toolIds: availableSelections.map((tool) => tool.id) }),
          )}
        </View>
      ) : null}
      {catalogError ? (
        <Text accessibilityRole="alert" style={ui.error}>
          {catalogError}
        </Text>
      ) : null}
      {!catalog.length ? (
        <Text style={ui.muted}>
          {loading
            ? "Loading this server’s tool catalog…"
            : "No catalog is available. Retry here or choose another server."}
        </Text>
      ) : null}
      {ui.button(loading ? "Loading catalog…" : "Retry tool catalog", retry, loading || !online)}
      <View style={ROW}>
        {ui.button(
          "Select all",
          () => update({ toolIds: eligible.map((tool) => tool.id) }),
          !online || !eligible.length || allSelected,
        )}
        {ui.button(
          "Clear selection",
          () => update({ toolIds: [] }),
          !online || !selectedUninstalled.length,
        )}
      </View>
      {catalog.map((tool) => (
        <OnboardingToolCard
          key={tool.id}
          tool={tool}
          ui={ui}
          checked={draft.toolIds.includes(tool.id)}
          online={online}
          onToggle={toggleTool}
        />
      ))}
      <Text style={ui.muted}>{setupSummary(batch)}</Text>
      <View style={NEXT}>
        {ui.button(
          "Choose setup agent →",
          () => update({ step: 3, toolIds: batch.map((tool) => tool.id) }),
          !batch.length || hasUnavailableSelection || !online,
          true,
        )}
      </View>
    </>
  );
}

function canSetUp(tool: ToolEntry) {
  return tool.installAvailable || Boolean(tool.sourceUrl) || tool.custom;
}
function chosenSetupEngine(
  engines: Record<string, string>,
  serverId: string,
  detected?: SetupEngine,
) {
  return engines[serverId] ?? (detected?.serverId === serverId ? detected.provider : undefined);
}
function toolSetupLabel(tool: ToolEntry) {
  if (tool.installed) return "Installed · connection check only";
  if (canSetUp(tool)) return "Not installed";
  return tool.installReason ?? "Add setup instructions before selecting this tool.";
}
function setupSummary(tools: ToolEntry[]) {
  const install = tools.filter((tool) => !tool.installed);
  const existing = tools.filter((tool) => tool.installed);
  return [
    install.length ? `Install: ${install.map((tool) => tool.name).join(", ")}` : "",
    existing.length ? `Connection check only: ${existing.map((tool) => tool.name).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
function OnboardingToolCard({
  tool,
  ui,
  checked,
  online,
  onToggle,
}: {
  tool: ToolEntry;
  ui: HubUi;
  checked: boolean;
  online: boolean;
  onToggle: (id: string) => void;
}) {
  const disabled = tool.installed || !online || !canSetUp(tool);
  const toggle = useCallback(() => onToggle(tool.id), [tool.id, onToggle]);
  const checkboxState = useMemo(
    () => ({ checked: tool.installed || checked, disabled }),
    [tool.installed, checked, disabled],
  );
  const card = useMemo(
    () =>
      tool.installed
        ? { ...ui.card, backgroundColor: ui.colors.surface2, borderColor: ui.colors.statusSuccess }
        : ui.card,
    [tool.installed, ui.card, ui.colors.surface2, ui.colors.statusSuccess],
  );
  return (
    <View style={card}>
      <View style={CARD_HEADER}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={tool.name}
          accessibilityState={checkboxState}
          disabled={disabled}
          onPress={toggle}
          style={CHECKBOX}
        >
          <Text style={ui.text}>{tool.installed || checked ? "☑" : "☐"}</Text>
          <Text style={ui.text}>{tool.name}</Text>
        </Pressable>
        <ToolGuide tool={tool} ui={ui} compact />
      </View>
      <Text style={ui.muted}>{toolSetupLabel(tool)}</Text>
    </View>
  );
}

function catalogIsLoading(hub: HubController, serverId: string) {
  return hub.loadingToolServers?.includes(serverId) ?? false;
}
