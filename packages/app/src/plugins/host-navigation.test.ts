import { describe, expect, it } from "vitest";
import { createPluginHostNavigation, preparePluginBrowserUrl } from "./host-navigation-model";

describe("plugin host navigation", () => {
  it("forwards only remote loopback URLs and never falls back to the local machine on failure", async () => {
    const calls: unknown[] = [];
    const forward = async (input: { sshEndpoint: string; url: string }) => {
      calls.push(input);
      return { url: "http://127.0.0.1:50000/chat?view=1#message" };
    };
    await expect(
      preparePluginBrowserUrl(
        {
          url: "http://localhost:8080/chat?view=1#message",
          sshEndpoint: "ssh://remote?daemonPort=6787",
          requiresSsh: true,
        },
        forward,
      ),
    ).resolves.toBe("http://127.0.0.1:50000/chat?view=1#message");
    expect(calls).toEqual([
      {
        sshEndpoint: "ssh://remote?daemonPort=6787",
        url: "http://localhost:8080/chat?view=1#message",
      },
    ]);
    await expect(
      preparePluginBrowserUrl({ url: "https://example.com", requiresSsh: true }, forward),
    ).resolves.toBe("https://example.com");
    await expect(
      preparePluginBrowserUrl({ url: "http://localhost:8080", requiresSsh: false }, forward),
    ).resolves.toBe("http://localhost:8080");
    await expect(
      preparePluginBrowserUrl({ url: "http://localhost:8080", requiresSsh: true }, forward),
    ).rejects.toThrow("Reconnect");
    await expect(
      preparePluginBrowserUrl(
        { url: "http://localhost:8080", sshEndpoint: "ssh://remote", requiresSsh: true },
        async () => {
          throw new Error("SSH failed");
        },
      ),
    ).rejects.toThrow("SSH failed");
    expect(calls).toHaveLength(1);
  });
  function setup(electron = true) {
    const destinations: unknown[] = [];
    const browsers: string[] = [];
    const workspaces = new Set(["selected:one", "remote:two"]);
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: electron,
      resolveWorkspace: ({ serverId, workspaceId }) =>
        workspaces.has(`${serverId}:${workspaceId}`) ? workspaceId : null,
      openAgent: (input) => destinations.push(input),
      openWorkspace: (input) => destinations.push(input),
      createBrowser: ({ initialUrl }) => {
        browsers.push(initialUrl);
        return { browserId: `browser-${browsers.length}` };
      },
    });
    return { navigation, destinations, browsers, workspaces };
  }

  it("creates and focuses a local browser in the selected or explicit host workspace", () => {
    const { navigation, destinations, browsers } = setup();
    navigation.openBrowser!({ url: "https://example.com/one", workspaceId: "one" });
    navigation.openBrowser!({
      url: "https://example.com/two",
      workspaceId: "two",
      serverId: "remote",
    });
    expect(browsers).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(destinations).toEqual([
      {
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "browser", browserId: "browser-1" },
      },
      {
        serverId: "remote",
        workspaceId: "two",
        target: { kind: "browser", browserId: "browser-2" },
      },
    ]);
  });

  it("refuses unknown or removed workspaces before creating browser records", () => {
    const { navigation, destinations, browsers, workspaces } = setup();
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "missing" }),
    ).toThrow("Workspace is unavailable");
    expect(() =>
      navigation.openBrowser!({
        url: "https://example.com",
        workspaceId: "one",
        serverId: "unknown",
      }),
    ).toThrow("Workspace is unavailable");
    workspaces.delete("selected:one");
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "one" }),
    ).toThrow("Workspace is unavailable");
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it("exposes no browser capability outside Electron and creates no tabs", () => {
    const { navigation, destinations, browsers } = setup(false);
    expect(navigation.openBrowser).toBeUndefined();
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it.each(["javascript:alert(1)", "file:///tmp/file", "/relative", "invalid"])(
    "rejects %s before creating a browser",
    (url) => {
      const { navigation, browsers, destinations } = setup();
      expect(() => navigation.openBrowser!({ url, workspaceId: "one" })).toThrow("HTTP(S)");
      expect(browsers).toEqual([]);
      expect(destinations).toEqual([]);
    },
  );

  it("rejects an empty workspace before creating a browser", () => {
    const { navigation, browsers } = setup();
    expect(() => navigation.openBrowser!({ url: "https://example.com", workspaceId: "" })).toThrow(
      "workspaceId",
    );
    expect(browsers).toEqual([]);
  });

  it("focuses a terminal on its actual host and rejects missing workspace or terminal IDs", () => {
    const { navigation, destinations } = setup();
    navigation.openTerminal!({ workspaceId: "one", terminalId: "local-term" });
    navigation.openTerminal!({ workspaceId: "two", terminalId: "remote-term", serverId: "remote" });
    expect(destinations).toEqual([
      {
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "terminal", terminalId: "local-term" },
      },
      {
        serverId: "remote",
        workspaceId: "two",
        target: { kind: "terminal", terminalId: "remote-term" },
      },
    ]);
    expect(() => navigation.openTerminal!({ workspaceId: "one", terminalId: "" })).toThrow(
      "terminalId",
    );
    expect(() => navigation.openTerminal!({ workspaceId: "missing", terminalId: "term" })).toThrow(
      "Workspace is unavailable",
    );
    expect(() =>
      navigation.openTerminal!({ workspaceId: "one", terminalId: "term", serverId: "remote" }),
    ).toThrow("Workspace is unavailable");
    expect(destinations).toHaveLength(2);
  });

  it("awaits remote URL preparation before creating a tab, preserving the remote workspace owner", async () => {
    const events: unknown[] = [];
    let finish!: (url: string) => void;
    const navigation = createPluginHostNavigation("local", {
      browserAvailable: true,
      resolveWorkspace: ({ workspaceId }) => workspaceId,
      openAgent: () => {},
      openWorkspace: (value) => {
        events.push(value);
      },
      createBrowser: ({ initialUrl }) => {
        events.push(initialUrl);
        return { browserId: "new-browser" };
      },
      prepareBrowserUrl: ({ serverId, url }) => {
        events.push({ serverId, url });
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const pending = navigation.openBrowser!({
      serverId: "remote",
      workspaceId: "remote-work",
      url: "http://localhost:8080/chat",
    });
    expect(events).toEqual([{ serverId: "remote", url: "http://localhost:8080/chat" }]);
    finish("http://127.0.0.1:50000/chat");
    await pending;
    expect(events.slice(1)).toEqual([
      "http://127.0.0.1:50000/chat",
      {
        serverId: "remote",
        workspaceId: "remote-work",
        target: { kind: "browser", browserId: "new-browser" },
      },
    ]);
  });

  it("does not create a local tab when remote URL preparation fails", async () => {
    const events: string[] = [];
    const navigation = createPluginHostNavigation("local", {
      browserAvailable: true,
      resolveWorkspace: ({ workspaceId }) => workspaceId,
      openAgent: () => {},
      openWorkspace: () => {},
      createBrowser: ({ initialUrl }) => {
        events.push(initialUrl);
        return { browserId: "never" };
      },
      prepareBrowserUrl: async () => {
        throw new Error("SSH unavailable");
      },
    });
    await expect(
      navigation.openBrowser!({
        serverId: "remote",
        workspaceId: "work",
        url: "http://localhost:8080",
      }),
    ).rejects.toThrow("SSH unavailable");
    expect(events).toEqual([]);
  });
});
