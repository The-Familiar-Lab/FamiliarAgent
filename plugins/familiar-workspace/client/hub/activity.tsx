import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  readCompositionActivity,
  type CompositionActivity,
  type EndpointActivity,
} from "../../shared/activity.js";
import { readToolRun } from "../../shared/tool-actions.js";
import { hostRpc } from "../fleet.js";
import { readWithDeadline } from "../read-deadline.js";
import { ROW, type HubUi } from "./ui.js";
import type { HubController } from "./controller.js";
import type { ResultFlow } from "./result-flow.js";

const ACTIVITY_POLL_MS = 4000;
const ACTIVITY_PAGE_SIZE = 20;
interface HostActivity {
  serverId: string;
  value?: CompositionActivity;
  error?: string;
  checking: boolean;
}
function useActivityVisibility() {
  const [node, setNode] = useState<unknown>(null);
  const ref = useCallback((value: unknown) => setNode(value), []);
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" ||
      (typeof IntersectionObserver === "undefined" && !document.hidden),
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    let intersects = typeof IntersectionObserver === "undefined";
    const update = () => setVisible(intersects && !document.hidden);
    const observer =
      typeof IntersectionObserver !== "undefined" && node instanceof Element
        ? new IntersectionObserver(([entry]) => {
            intersects = entry?.isIntersecting ?? false;
            update();
          })
        : null;
    if (observer) observer.observe(node as Element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [node]);
  return { ref, visible };
}
export function useSessionActivity(hub: HubController, enabled = true) {
  const [version, setVersion] = useState(0);
  const sessionId = hub.session?.id;
  const scope = `${hub.host.id}:${sessionId ?? ""}`;
  const hostKey = JSON.stringify(
    [...new Set([hub.host.id, ...(hub.session?.endpoints.map((item) => item.serverId) ?? [])])]
      .sort()
      .map((id) => [id, hub.hosts.find((host) => host.serverId === id)?.status === "online"]),
  );
  const [result, setResult] = useState<{ scope: string; hosts: HostActivity[] }>({
    scope,
    hosts: [],
  });
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let current = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const hosts = JSON.parse(hostKey) as Array<[string, boolean]>;
    setResult((previous) => {
      const last = new Map<string, HostActivity>();
      if (previous.scope === scope)
        for (const host of previous.hosts) last.set(host.serverId, host);
      return {
        scope,
        hosts: hosts.map(([serverId, online]) => ({
          ...last.get(serverId),
          serverId,
          checking: online,
          error: online ? undefined : "Server is offline. Reconnect it to check the original work.",
        })),
      };
    });
    const publish = (serverId: string, value: Partial<HostActivity>) => {
      if (current)
        setResult((previous) => ({
          scope,
          hosts: previous.hosts.map((item) =>
            item.serverId === serverId ? { ...item, ...value } : item,
          ),
        }));
    };
    const check = async (serverId: string) => {
      try {
        const value = await readWithDeadline(
          hostRpc(serverId, readCompositionActivity, {
            id: sessionId,
            offset: 0,
            limit: ACTIVITY_PAGE_SIZE,
          }),
          "Session activity",
        );
        if (!current) return;
        if (value.sessionId !== sessionId || value.serverId !== serverId)
          throw new Error("The activity response belongs to another session or server.");
        publish(serverId, { value, checking: false, error: undefined });
        if (
          value.endpoints.some((item) => item.state === "starting" || item.state === "running") ||
          value.runs.some((item) => item.state === "running")
        ) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            void check(serverId);
          }, ACTIVITY_POLL_MS);
          timers.add(timer);
        }
      } catch (error) {
        publish(serverId, {
          checking: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    for (const [serverId, online] of hosts) if (online) void check(serverId);
    return () => {
      current = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [scope, sessionId, hub.session?.revision, hostKey, version, enabled]);
  return {
    hosts: result.scope === scope ? result.hosts : [],
    refresh: () => setVersion((value) => value + 1),
  };
}

function EndpointCard({
  endpoint,
  hub,
  ui,
  stale,
}: {
  endpoint: EndpointActivity;
  hub: HubController;
  ui: HubUi;
  stale: boolean;
}) {
  const open = () => {
    if (hub.session)
      void hub.run(() => hub.openEndpoint({ id: endpoint.endpointId }, hub.session!.id));
  };
  const recover = () => {
    hub.openSetup(endpoint.serverId, endpoint.toolId);
    hub.setCwd(endpoint.cwd);
  };
  return (
    <View style={ui.card}>
      <Text style={ui.toolHeading}>
        {endpoint.toolId} · {hub.hostName(endpoint.serverId)}
      </Text>
      <Text style={ui.text}>
        {stale ? "Last observed: " : ""}
        {endpoint.state} ·{" "}
        {endpoint.readiness === "unknown" ? "Readiness not reported" : endpoint.readiness}
      </Text>
      <Text style={ui.muted}>{endpoint.detail}</Text>
      <Text selectable style={ui.muted}>
        {endpoint.cwd}
      </Text>
      <View style={ROW}>
        {ui.button("Open original", open, stale)}
        {endpoint.kind === "desktop" && endpoint.workspaceId && hub.navigation?.openTerminal
          ? ui.button(
              "View launcher",
              () =>
                hub.navigation!.openTerminal!({
                  serverId: endpoint.serverId,
                  workspaceId: endpoint.workspaceId!,
                  terminalId: endpoint.nativeId,
                }),
              stale,
            )
          : null}
        {endpoint.state === "closed" || endpoint.state === "unavailable"
          ? ui.button("Check setup / launch again", recover, stale)
          : null}
      </View>
    </View>
  );
}
function ActionCard({
  run,
  serverId,
  hub,
  ui,
  flow,
  stale,
}: {
  run: CompositionActivity["runs"][number];
  serverId: string;
  hub: HubController;
  ui: HubUi;
  flow: ResultFlow;
  stale: boolean;
}) {
  const [full, setFull] = useState<string | null>(null);
  const read = async () => hostRpc(serverId, readToolRun, { id: run.runId });
  const view = async () => {
    const original = await read();
    if (original.request.sessionId !== hub.session?.id)
      throw new Error("This result belongs to another session.");
    setFull(
      original.result?.text ?? original.error ?? "The original action has not returned a result.",
    );
  };
  const open = () => {
    hub.setTarget(serverId);
    hub.setCwd(run.cwd);
    hub.setToolId(run.toolId);
    hub.setTab("Tools");
  };
  return (
    <View style={ui.card}>
      <Text style={ui.toolHeading}>
        {run.toolId} · {run.action} · {hub.hostName(serverId)}
      </Text>
      <Text style={ui.text}>
        {stale ? "Last observed: " : ""}
        {run.state} · {run.updatedAt}
      </Text>
      {run.state === "submitted" ? (
        <Text style={ui.muted}>
          The original tool accepted the request. Its task completion is not confirmed.
        </Text>
      ) : null}
      {run.state === "unknown" ? (
        <Text style={ui.muted}>Check the original task before starting another attempt.</Text>
      ) : null}
      <Text selectable style={ui.muted}>
        {run.cwd}
      </Text>
      <View style={ROW}>
        {ui.button("Open original actions", open)}
        {ui.button(full === null ? "View result" : "Hide result", () => {
          if (full === null) void hub.run(view);
          else setFull(null);
        })}
        {run.state === "completed" && run.hasResult
          ? ui.button(
              "Use result…",
              () => {
                void hub.run(async () => flow.useToolResult(await read()));
              },
              stale,
            )
          : null}
      </View>
      {full !== null ? (
        <Text selectable style={ui.text}>
          {full}
        </Text>
      ) : null}
    </View>
  );
}
export function HubActivity({
  hub,
  ui,
  flow,
}: {
  hub: HubController;
  ui: HubUi;
  flow: ResultFlow;
}) {
  const visibility = useActivityVisibility();
  const activity = useSessionActivity(hub, visibility.visible);
  const runs = useMemo(
    () =>
      activity.hosts
        .flatMap(({ serverId, value, error }) =>
          (value?.runs ?? []).map((run) => ({ serverId, run, stale: !!error })),
        )
        .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt)),
    [activity.hosts],
  );
  if (!hub.session) return null;
  return (
    <View style={ui.card} ref={visibility.ref}>
      <Text style={ui.sectionHeading}>Session activity · {hub.session.title}</Text>
      <Text style={ui.muted}>
        Original tools keep their own work. Status below is read from each server; an open interface
        does not mean its task is complete.
      </Text>
      <View style={ROW}>
        {ui.button("Refresh activity", activity.refresh)}
        {ui.button("Inputs / Results", () => hub.setTab("Inputs / Results"))}
      </View>
      {hub.pendingLaunch?.sessionId === hub.session.id ? (
        <View style={ui.card}>
          <Text style={ui.muted}>
            An original interface is waiting to be linked. Retrying this step does not start another
            process.
          </Text>
          {ui.button("Retry linking original", () => {
            void hub.run(hub.recoverLaunch);
          })}
        </View>
      ) : null}
      {activity.hosts.map((host) => (
        <View key={host.serverId} style={ui.card}>
          <Text style={ui.text}>
            {hub.hostName(host.serverId)}
            {host.value ? ` · Checked ${host.value.observedAt}` : ""}
          </Text>
          {host.checking ? <Text style={ui.muted}>Checking original status…</Text> : null}
          {host.error ? (
            <Text accessibilityRole="alert" style={ui.error}>
              {host.error}
            </Text>
          ) : null}
          {host.value?.endpoints.map((endpoint) => (
            <EndpointCard
              key={endpoint.endpointId}
              endpoint={endpoint}
              hub={hub}
              ui={ui}
              stale={!!host.error}
            />
          ))}
          {host.value && !host.value.endpoints.length && !host.value.runs.length ? (
            <Text style={ui.muted}>No original work is linked on this server yet.</Text>
          ) : null}
          {host.value && host.value.totalRuns > host.value.runs.length ? (
            <Text style={ui.muted}>
              Latest {ACTIVITY_PAGE_SIZE} actions shown. Open original actions for older results.
            </Text>
          ) : null}
        </View>
      ))}
      {runs.map(({ serverId, run, stale }) => (
        <ActionCard
          key={`${serverId}:${run.runId}`}
          run={run}
          serverId={serverId}
          hub={hub}
          ui={ui}
          flow={flow}
          stale={stale}
        />
      ))}
    </View>
  );
}
