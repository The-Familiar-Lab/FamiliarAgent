import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginHostSummary } from "@getpaseo/plugin/client";
import {
  parseSshTransportUri,
  validatePort,
  validateSshHost,
} from "@getpaseo/protocol/ssh-transport";

/** Only connection coordinates cross the plugin boundary, never URL credentials. */
export function publicSshConnection(endpoint: string | undefined): string | undefined {
  if (!endpoint || endpoint.length > 4096) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "ssh:") return undefined;
    url.password = "";
    url.pathname = "";
    url.hash = "";
    const daemonPorts = url.searchParams.getAll("daemonPort");
    url.search = "";
    if (daemonPorts.length === 1) url.searchParams.set("daemonPort", daemonPorts[0]);
    if (daemonPorts.length > 1) return undefined;
    const safe = url.toString();
    parseSshTransportUri(safe);
    return safe;
  } catch {
    return undefined;
  }
}

function untilStopped<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Plugin has stopped"));
  let cancel!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error("Plugin has stopped"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  return Promise.race([request, stopped]).finally(() =>
    signal.removeEventListener("abort", cancel),
  );
}

interface HostConnectionCoordinates {
  id?: string;
  type: string;
  endpoint?: string;
  host?: string;
  sshPort?: number;
  daemonPort?: number;
}
interface HostActiveCoordinates {
  activeConnectionId?: string | null;
  activeConnection?: { type: string; endpoint?: string } | null;
}

function configuredSshConnection(connection: HostConnectionCoordinates): string | undefined {
  if (!connection.host) return undefined;
  try {
    const host = validateSshHost(connection.host);
    const at = host.lastIndexOf("@");
    const username = at < 0 ? "" : host.slice(0, at + 1);
    const hostname = host.slice(at + 1);
    const authority =
      hostname.includes(":") && !hostname.startsWith("[") ? `${username}[${hostname}]` : host;
    const url = new URL(host.includes("://") ? host : `ssh://${authority}`);
    if (connection.sshPort !== undefined)
      url.port = String(validatePort(connection.sshPort, "SSH port"));
    if (connection.daemonPort !== undefined)
      url.searchParams.set(
        "daemonPort",
        String(validatePort(connection.daemonPort, "Daemon port")),
      );
    return publicSshConnection(url.toString());
  } catch {
    return undefined;
  }
}

/** The active runtime endpoint is a bare SSH host; ports live on its selected profile. */
export function publicSshHostConnection(
  state: HostActiveCoordinates | null | undefined,
  connections?: readonly HostConnectionCoordinates[],
): string | undefined {
  const active = state?.activeConnection;
  if (active?.type !== "remoteSsh") return undefined;
  const candidates = connections?.filter(
    (item) =>
      item.type === "remoteSsh" &&
      (state?.activeConnectionId
        ? item.id === state.activeConnectionId
        : item.host === active.endpoint),
  );
  if (candidates?.length === 1) return configuredSshConnection(candidates[0]!);
  // Older callers may already provide the full URI. Never guess ports from a bare alias.
  return publicSshConnection(active.endpoint);
}
export function isLocalPluginConnection(connection: HostConnectionCoordinates): boolean {
  if (connection.type === "directSocket" || connection.type === "directPipe") return true;
  if (connection.type !== "directTcp" || !connection.endpoint) return false;
  try {
    const endpoint = connection.endpoint.includes("://")
      ? connection.endpoint
      : `http://${connection.endpoint}`;
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname.toLowerCase());
  } catch {
    return false;
  }
}
export interface PluginHostsSource {
  getHosts(): readonly {
    serverId: string;
    label: string;
    connections?: readonly HostConnectionCoordinates[];
  }[];
  getSnapshot(serverId: string): {
    connectionStatus: PluginHostSummary["status"];
    client: DaemonClient | null;
    activeConnection?: { type: string; endpoint?: string } | null;
    activeConnectionId?: string | null;
  } | null;
  subscribeAll(listener: () => void): () => void;
  subscribeHostList(listener: () => void): () => void;
}

/** Each evaluated installation owns its borrowed APIs and registry subscriptions. */
export function createPluginHosts(source: PluginHostsSource, signal: AbortSignal) {
  const clients = new Map<
    string,
    { client: DaemonClient; api: PaseoApi; lifetime: AbortController }
  >();
  const listeners = new Set<() => void>();
  let snapshot: readonly PluginHostSummary[] = [];
  function readHosts(): readonly PluginHostSummary[] {
    return source.getHosts().map(({ serverId, label, connections }) => {
      const state = source.getSnapshot(serverId);
      const active = state?.activeConnection;
      const connection = publicSshHostConnection(state, connections);
      const summary = {
        serverId,
        label,
        status: state?.connectionStatus ?? "offline",
      };
      const local =
        active?.type !== "remoteSsh" &&
        (connections?.some(isLocalPluginConnection) || (active && isLocalPluginConnection(active)));
      if (local) Object.assign(summary, { isLocal: true });
      return connection ? Object.assign(summary, { connection }) : summary;
    });
  }
  function resolve(serverId: string): DaemonClient {
    if (signal.aborted) throw new Error("Plugin has stopped");
    if (!source.getHosts().some((host) => host.serverId === serverId)) {
      throw new Error(`Unknown Paseo host: ${serverId}`);
    }
    const host = source.getSnapshot(serverId);
    if (host?.connectionStatus !== "online" || !host.client) {
      throw new Error(`Paseo host is disconnected: ${serverId}`);
    }
    return host.client;
  }
  function refresh() {
    for (const [serverId, entry] of clients) {
      if (
        !source.getHosts().some((host) => host.serverId === serverId) ||
        source.getSnapshot(serverId)?.client !== entry.client
      ) {
        entry.lifetime.abort();
        clients.delete(serverId);
      }
    }
    const next = readHosts();
    if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }
  snapshot = readHosts();
  const unsubscribeRuntime = source.subscribeAll(refresh);
  const unsubscribeHosts = source.subscribeHostList(refresh);
  function stop() {
    unsubscribeRuntime();
    unsubscribeHosts();
    listeners.clear();
    for (const entry of clients.values()) entry.lifetime.abort();
    clients.clear();
  }
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return {
    invokePluginRpc(serverId: string, pluginId: string, method: string, input: unknown) {
      const client = resolve(serverId);
      return untilStopped(client.invokePluginRpc(pluginId, method, input), signal).then(
        (result) => {
          if (resolve(serverId) !== client)
            throw new Error(`Paseo connection changed during request: ${serverId}`);
          return result;
        },
      );
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (signal.aborted) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getPaseoClient(serverId: string): PaseoApi {
      const client = resolve(serverId);
      const existing = clients.get(serverId);
      if (existing?.client === client) return existing.api;
      existing?.lifetime.abort();
      const lifetime = new AbortController();
      // Guard even retained SDK handles against unload, offline calls, and replaced connections.
      // Methods keep the real receiver because DaemonClient owns private state.
      const borrowed = new Proxy(client, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (lifetime.signal.aborted) throw new Error(`Paseo client is released: ${serverId}`);
            if (resolve(serverId) !== client) {
              throw new Error(`Paseo connection changed; call getPaseoClient again: ${serverId}`);
            }
            return Reflect.apply(value, target, args);
          };
        },
      });
      const api = createPaseoApi(borrowed, { signal: lifetime.signal });
      const dispose = api.dispose;
      api.dispose = () => {
        if (clients.get(serverId)?.api === api) clients.delete(serverId);
        lifetime.abort();
        return dispose();
      };
      clients.set(serverId, { client, api, lifetime });
      return api;
    },
  };
}
