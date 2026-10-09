// @vitest-environment jsdom
import React from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NewTabLauncherProvider, useWorkspaceTabLaunchCatalog, type NewTabLauncher } from "./index";
vi.mock("@/plugins/icons", () => ({ resolvePluginIcon: () => () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  tools: [
    { id: "goose", name: "Goose" },
    { id: "openrig", name: "OpenRig" },
    { id: "new-tool", name: "New native tool" },
  ],
  error: undefined as string | undefined,
  reload: vi.fn(),
}));
vi.mock("@/hooks/use-daemon-config", () => ({ useDaemonConfig: () => ({ config: null }) }));
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugins: () => [
    {
      serverId: "linux",
      id: "familiar-workspace",
      workspacePanels: [
        {
          id: "shared",
          title: "Familiar Hub",
          icon: "Network",
          context: "workspace",
          locations: ["workspace", "explorer"],
        },
      ],
    },
  ],
}));
vi.mock("./internal/familiar-tools", () => ({
  useFamiliarToolCatalog: () => ({
    tools: mocks.tools,
    error: mocks.error,
    loading: false,
    reload: mocks.reload,
  }),
}));
vi.mock("@/panels/register-panels", () => ({ ensurePanelsRegistered: () => {} }));
vi.mock("@/panels/panel-registry", () => ({
  getPanelRegistration: () => ({ presentation: { label: () => "Native view" } }),
}));
vi.mock("@/stores/workspace-layout-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/workspace-layout-store")>()),
  useWorkspaceLayoutStore: {
    getState: () => ({
      layoutByWorkspace: {
        "linux:work": {
          root: {
            kind: "pane",
            pane: {
              id: "main",
              tabIds: ["chat"],
              focusedTabId: "chat",
              tabs: [{ tabId: "chat", createdAt: 0, target: { kind: "agent", agentId: "A" } }],
            },
          },
          focusedPaneId: "main",
        },
      },
    }),
  },
}));
const launcher: NewTabLauncher = {
  workspaceId: "work",
  cwd: "/source",
  showChanges: true,
  showPullRequest: true,
  showBrowser: true,
  terminalDisabled: false,
  launch: mocks.launch,
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.error = undefined;
});
function wrapper({ children }: { children: React.ReactNode }) {
  return <NewTabLauncherProvider value={launcher}>{children}</NewTabLauncherProvider>;
}
it("renders every returned tool, and each missing or future tool click opens its scoped setup panel", () => {
  const { result } = renderHook(
    () =>
      useWorkspaceTabLaunchCatalog({
        serverId: "linux",
        purpose: "supporting",
        host: "explorer",
        surface: "panel",
      }),
    { wrapper },
  );
  const group = result.current.find((item) => item.id === "familiar-tools")!;
  expect(result.current[0]!.items.some((item) => item.id === "files")).toBe(true);
  expect(group.items.map((item) => item.label)).toEqual(["Goose", "OpenRig", "New native tool"]);
  for (const item of group.items) {
    expect(item.disabled).toBe(false);
    item.launch({ kind: "replace", tabId: "new" });
    expect(mocks.launch).toHaveBeenLastCalledWith(
      {
        kind: "target",
        target: expect.objectContaining({
          params: {
            serverId: "linux",
            workspaceId: "work",
            cwd: "/source",
            agentId: "A",
            toolId: item.id.split(":")[1],
            setup: "1",
          },
        }),
      },
      { kind: "replace", tabId: "new" },
    );
  }
});
it("retains terminal/browser/files and makes the Hub panel inherit the current chat", () => {
  const { result } = renderHook(
    () =>
      useWorkspaceTabLaunchCatalog({
        serverId: "linux",
        purpose: "primary",
        host: "main",
        surface: "panel",
      }),
    { wrapper },
  );
  expect(result.current[0]!.items.map((item) => item.id)).toEqual(
    expect.arrayContaining(["terminal", "browser", "agent"]),
  );
  result.current
    .find((item) => item.id === "plugin-panels")!
    .items[0]!.launch({ kind: "open", paneId: "side" });
  expect(mocks.launch).toHaveBeenCalledWith(
    {
      kind: "target",
      target: expect.objectContaining({
        params: { serverId: "linux", workspaceId: "work", cwd: "/source", agentId: "A" },
      }),
    },
    { kind: "open", paneId: "side" },
  );
});
it("routes built-in Goose and OpenRig terminal shortcuts through setup instead of raw terminal spawn", () => {
  const { result } = renderHook(
    () =>
      useWorkspaceTabLaunchCatalog({
        serverId: "linux",
        purpose: "primary",
        host: "main",
        surface: "panel",
      }),
    { wrapper },
  );
  const profiles = result.current.find((group) => group.id === "terminal-profiles")!;
  for (const id of ["goose", "openrig"]) {
    profiles.items.find((item) => item.id === `terminal-profile:${id}`)!.launch({ kind: "open" });
    expect(mocks.launch).toHaveBeenLastCalledWith(
      {
        kind: "target",
        target: expect.objectContaining({
          params: expect.objectContaining({
            toolId: id,
            setup: "1",
            serverId: "linux",
            agentId: "A",
          }),
        }),
      },
      { kind: "open" },
    );
  }
  profiles.items.find((item) => item.id === "terminal-profile:codex")!.launch({ kind: "open" });
  expect(mocks.launch).toHaveBeenLastCalledWith(
    { kind: "terminal", profile: expect.objectContaining({ id: "codex" }) },
    { kind: "open" },
  );
});
it("shows a retry action on catalog failure while preserving the Hub entry", () => {
  mocks.error = "Host disconnected";
  const { result } = renderHook(
    () =>
      useWorkspaceTabLaunchCatalog({
        serverId: "linux",
        purpose: "primary",
        host: "main",
        surface: "panel",
      }),
    { wrapper },
  );
  const tools = result.current.find((item) => item.id === "familiar-tools")!;
  expect(tools.notice).toContain("Host disconnected");
  tools.accessory!.run();
  expect(mocks.reload).toHaveBeenCalledOnce();
  expect(result.current.find((item) => item.id === "plugin-panels")!.items).toHaveLength(1);
});
