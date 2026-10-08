import { describe, expect, it, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  createPluginHosts,
  publicSshConnection,
  publicSshHostConnection,
  isLocalPluginConnection,
  type PluginHostsSource,
} from "./index";

function registry() {
  const hosts = [
    { serverId: "a", label: "Alpha", password: "secret" },
    { serverId: "b", label: "Beta", password: "secret" },
  ];
  const snapshots = new Map<string, NonNullable<ReturnType<PluginHostsSource["getSnapshot"]>>>();
  const listeners = new Set<() => void>();
  const source: PluginHostsSource = {
    getHosts: () => hosts,
    getSnapshot: (id) => snapshots.get(id) ?? null,
    subscribeAll(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeHostList(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const lifetime = new AbortController();
  const runtime = createPluginHosts(source, lifetime.signal);
  return {
    hosts,
    snapshots,
    listeners,
    lifetime,
    runtime,
    source,
    publish() {
      for (const listener of listeners) listener();
    },
  };
}
function ignoreUpdate() {}

function connection(id: string) {
  return new DaemonClient({ url: `ws://${id}`, clientId: "test", reconnect: { enabled: false } });
}

describe("plugin host access", () => {
  it("identifies local endpoints explicitly without mistaking SSH, relay, or remote TCP for local", () => {
    for (const endpoint of [
      "localhost:6786",
      "127.0.0.1:6786",
      "[::1]:6786",
      "ws://localhost:6786",
    ])
      expect(isLocalPluginConnection({ type: "directTcp", endpoint })).toBe(true);
    for (const type of ["remoteSsh", "relay"])
      expect(isLocalPluginConnection({ type, endpoint: "http://localhost:6786" })).toBe(false);
    expect(isLocalPluginConnection({ type: "directTcp", endpoint: "remote.example:6786" })).toBe(
      false,
    );
    expect(isLocalPluginConnection({ type: "directTcp", endpoint: "localhost.example:6786" })).toBe(
      false,
    );
    expect(isLocalPluginConnection({ type: "directSocket" })).toBe(true);
    const h = registry();
    h.source.getHosts = () => [
      {
        serverId: "a",
        label: "Local",
        connections: [{ type: "directTcp", endpoint: "localhost:6786" }],
      },
    ];
    h.publish();
    expect(h.runtime.getSnapshot()[0]).toMatchObject({ isLocal: true, status: "offline" });
    h.lifetime.abort();
  });
  it("only publishes sanitized SSH coordinates and excludes relay credentials", () => {
    expect(
      publicSshConnection(
        "ssh://mingi:private-password@server:2222/private?token=secret&daemonPort=6787#private",
      ),
    ).toBe("ssh://mingi@server:2222?daemonPort=6787");
    expect(publicSshConnection("ssh://example-host?daemonPort=6787")).toBe(
      "ssh://example-host?daemonPort=6787",
    );
    expect(publicSshConnection("ssh://server?daemonPort=bad")).toBeUndefined();
    expect(publicSshConnection("ssh://server?daemonPort=123&daemonPort=456")).toBeUndefined();
    expect(publicSshConnection("https://relay.test?token=secret")).toBeUndefined();
    const h = registry();
    h.snapshots.set("a", {
      connectionStatus: "online",
      client: connection("a"),
      activeConnection: { type: "relay", endpoint: "https://relay.test?token=secret" },
    });
    h.snapshots.set("b", {
      connectionStatus: "online",
      client: connection("b"),
      activeConnection: {
        type: "remoteSsh",
        endpoint: "ssh://user:password@server?daemonPort=6787&token=secret",
      },
    });
    h.publish();
    expect(h.runtime.getSnapshot()[0]).not.toHaveProperty("connection");
    expect(h.runtime.getSnapshot()[1].connection).toBe("ssh://user@server?daemonPort=6787");
    expect(JSON.stringify(h.runtime.getSnapshot())).not.toMatch(/secret|password|token/u);
    h.lifetime.abort();
  });
  it("publishes the actual bare SSH alias with ports from its selected profile", () => {
    const h = registry();
    Object.assign(h.hosts[1]!, {
      connections: [
        { id: "other", type: "remoteSsh", host: "other-server", daemonPort: 9000 },
        { id: "ssh-selected", type: "remoteSsh", host: "example-host", daemonPort: 6787 },
      ],
    });
    h.snapshots.set("b", {
      connectionStatus: "online",
      client: connection("b"),
      activeConnectionId: "ssh-selected",
      activeConnection: { type: "remoteSsh", endpoint: "example-host" },
    });
    h.publish();
    expect(h.runtime.getSnapshot()[1]).toEqual({
      serverId: "b",
      label: "Beta",
      status: "online",
      connection: "ssh://example-host?daemonPort=6787",
    });
    h.lifetime.abort();
  });
  it.each([
    ["mingi@server", "ssh://mingi@server:2222?daemonPort=6787"],
    ["mingi@[2001:db8::1]", "ssh://mingi@[2001:db8::1]:2222?daemonPort=6787"],
    ["mingi@2001:db8::1", "ssh://mingi@[2001:db8::1]:2222?daemonPort=6787"],
    ["2001:db8::1", "ssh://[2001:db8::1]:2222?daemonPort=6787"],
    ["localhost", "ssh://localhost:2222?daemonPort=6787"],
  ])("retains SSH and daemon ports for %s", (host, expected) => {
    expect(
      publicSshHostConnection(
        {
          activeConnectionId: "ssh",
          activeConnection: { type: "remoteSsh", endpoint: host },
        },
        [{ id: "ssh", type: "remoteSsh", host, sshPort: 2222, daemonPort: 6787 }],
      ),
    ).toBe(expected);
  });
  it("keeps an active SSH loopback host remote even when an older local TCP profile is saved", () => {
    const h = registry();
    Object.assign(h.hosts[1]!, {
      connections: [
        { id: "local", type: "directTcp", endpoint: "localhost:6767" },
        { id: "ssh", type: "remoteSsh", host: "127.0.0.1", daemonPort: 6787 },
      ],
    });
    h.snapshots.set("b", {
      connectionStatus: "online",
      client: connection("b"),
      activeConnectionId: "ssh",
      activeConnection: { type: "remoteSsh", endpoint: "127.0.0.1" },
    });
    h.publish();
    expect(h.runtime.getSnapshot()[1].connection).toBe("ssh://127.0.0.1?daemonPort=6787");
    expect(h.runtime.getSnapshot()[1]).not.toHaveProperty("isLocal");
    h.lifetime.abort();
  });
  it("sanitizes configured URI credentials and rejects invalid configured ports", () => {
    const active = {
      activeConnectionId: "ssh",
      activeConnection: { type: "remoteSsh", endpoint: "server" },
    };
    expect(
      publicSshHostConnection(active, [
        {
          id: "ssh",
          type: "remoteSsh",
          host: "ssh://user:password@server/private?daemonPort=6787&token=secret#private",
        },
      ]),
    ).toBe("ssh://user@server?daemonPort=6787");
    for (const invalid of [{ sshPort: 0 }, { daemonPort: 65536 }, { daemonPort: 1.5 }])
      expect(
        publicSshHostConnection(active, [
          { id: "ssh", type: "remoteSsh", host: "server", ...invalid },
        ]),
      ).toBeUndefined();
  });
  it("does not infer ports from an unmatched bare runtime alias or borrow another transport's SSH profile", () => {
    const connections = [{ id: "ssh", type: "remoteSsh", host: "server", daemonPort: 6787 }];
    expect(
      publicSshHostConnection(
        {
          activeConnectionId: "unknown",
          activeConnection: { type: "remoteSsh", endpoint: "server" },
        },
        connections,
      ),
    ).toBeUndefined();
    expect(
      publicSshHostConnection({ activeConnection: { type: "remoteSsh", endpoint: "server" } }),
    ).toBeUndefined();
    expect(
      publicSshHostConnection(
        {
          activeConnectionId: "direct",
          activeConnection: { type: "directTcp", endpoint: "localhost:1234" },
        },
        connections,
      ),
    ).toBeUndefined();
  });

  it("routes RPC to the requested host and rejects after disposal without another network call", async () => {
    const h = registry(),
      a = connection("a"),
      b = connection("b");
    const first = vi.spyOn(a, "invokePluginRpc").mockResolvedValue({ from: "a" });
    const second = vi.spyOn(b, "invokePluginRpc").mockResolvedValue({ from: "b" });
    h.snapshots.set("a", { connectionStatus: "online", client: a });
    h.snapshots.set("b", { connectionStatus: "online", client: b });
    await expect(
      h.runtime.invokePluginRpc("b", "own-plugin", "history.read", { id: "one" }),
    ).resolves.toEqual({ from: "b" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("own-plugin", "history.read", { id: "one" });
    h.lifetime.abort();
    expect(() => h.runtime.invokePluginRpc("a", "own-plugin", "history.read", {})).toThrow(
      "Plugin has stopped",
    );
    expect(first).not.toHaveBeenCalled();
  });

  it("rejects in-flight RPC when its installation stops and ignores replaced-connection results", async () => {
    const h = registry(),
      client = connection("a");
    let finish!: (value: unknown) => void;
    vi.spyOn(client, "invokePluginRpc").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.snapshots.set("a", { connectionStatus: "online", client });
    const changed = h.runtime.invokePluginRpc("a", "plugin", "read", {});
    h.snapshots.set("a", { connectionStatus: "online", client: connection("replacement") });
    finish({ stale: true });
    await expect(changed).rejects.toThrow("connection changed during request");
    h.snapshots.set("a", { connectionStatus: "online", client });
    const stopped = h.runtime.invokePluginRpc("a", "plugin", "read", {});
    h.lifetime.abort();
    await expect(stopped).rejects.toThrow("Plugin has stopped");
    finish({ ignored: true });
  });
  it("publishes credential-free configured hosts and only changes snapshots when summaries change", () => {
    const h = registry();
    expect(h.runtime.getSnapshot()).toEqual([
      { serverId: "a", label: "Alpha", status: "offline" },
      { serverId: "b", label: "Beta", status: "offline" },
    ]);
    const before = h.runtime.getSnapshot();
    h.publish();
    expect(h.runtime.getSnapshot()).toBe(before);
    let updates = 0;
    h.runtime.subscribe(() => updates++);
    h.snapshots.set("b", { connectionStatus: "connecting", client: null });
    h.publish();
    expect(updates).toBe(1);
    expect(h.runtime.getSnapshot()[1].status).toBe("connecting");
    h.hosts[1].label = "Renamed";
    h.publish();
    expect(h.runtime.getSnapshot()[1].label).toBe("Renamed");
    h.lifetime.abort();
    expect(h.listeners.size).toBe(0);
  });

  it("rejects unknown and disconnected targets without falling through to another host", () => {
    const h = registry();
    h.snapshots.set("a", { connectionStatus: "online", client: connection("a") });
    expect(() => h.runtime.getPaseoClient("missing")).toThrow("Unknown Paseo host: missing");
    expect(() => h.runtime.getPaseoClient("b")).toThrow("Paseo host is disconnected: b");
    h.lifetime.abort();
  });

  it("isolates installation lifetimes and releases APIs when a connection is replaced", async () => {
    const h = registry();
    const client = connection("b");
    h.snapshots.set("b", { connectionStatus: "online", client });
    h.publish();
    const otherLifetime = new AbortController();
    const other = createPluginHosts(h.source, otherLifetime.signal);
    const api = h.runtime.getPaseoClient("b");
    expect(api).toBe(h.runtime.getPaseoClient("b"));
    expect(api).not.toBe(other.getPaseoClient("b"));
    expect(api).not.toHaveProperty("connect");
    expect(api).not.toHaveProperty("close");
    api.agents.subscribe(ignoreUpdate);
    h.snapshots.set("b", { connectionStatus: "offline", client });
    h.publish();
    expect(() => h.runtime.getPaseoClient("b")).toThrow("disconnected");
    expect(() => api.config.get()).toThrow("Paseo host is disconnected: b");
    h.snapshots.set("b", { connectionStatus: "online", client });
    h.publish();
    expect(h.runtime.getPaseoClient("b")).toBe(api);
    h.snapshots.set("b", { connectionStatus: "online", client: connection("new-b") });
    h.publish();
    expect(() => api.agents.subscribe(ignoreUpdate)).toThrow("disposed");
    expect(() => api.config.get()).toThrow("Paseo client is released: b");
    expect(h.runtime.getPaseoClient("b")).not.toBe(api);
    h.lifetime.abort();
    expect(() => h.runtime.getPaseoClient("b")).toThrow("Plugin has stopped");
    expect(() => other.getPaseoClient("b").agents.subscribe(ignoreUpdate)).not.toThrow();
    otherLifetime.abort();
  });
});

it("reacquires a fresh API after explicit disposal without affecting a later borrower", async () => {
  const h = registry();
  h.snapshots.set("b", { connectionStatus: "online", client: connection("b") });
  const first = h.runtime.getPaseoClient("b");
  await first.dispose();
  const second = h.runtime.getPaseoClient("b");
  expect(second).not.toBe(first);
  expect(() => second.agents.subscribe(ignoreUpdate)).not.toThrow();
  expect(() => first.config.get()).toThrow("Paseo client is released: b");
  await first.dispose();
  expect(h.runtime.getPaseoClient("b")).toBe(second);
  h.lifetime.abort();
  expect(() => second.agents.subscribe(ignoreUpdate)).toThrow("disposed");
});
