import { beforeEach, expect, it, vi } from "vitest";
import { prepareOriginalView } from "./original-view.js";
import type { ToolEntry, ToolPlan } from "../../shared/tool-catalog.js";
const mocks = vi.hoisted(() => ({ client: vi.fn(), workspace: vi.fn(), terminal: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({
  getPaseoClient: (serverId: string) => {
    mocks.client(serverId);
    return { workspaces: { open: mocks.workspace }, terminals: { create: mocks.terminal } };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockResolvedValue({ id: "remote-workspace" });
  mocks.terminal.mockResolvedValue({ id: "original-process" });
});
const tool = { id: "native", name: "Native tool" } as ToolEntry;
const plan: ToolPlan = {
  toolId: "native",
  action: "launch",
  mode: "terminal",
  cwd: "/remote/project",
  command: "/usr/bin/env",
  args: ["PATH=/native/bin", "native", "--project", "/remote/project"],
  notes: [],
};
it("keeps native command/environment arguments intact and delays navigation until linking", async () => {
  const openTerminal = vi.fn();
  const value = await prepareOriginalView({
    serverId: "linux",
    tool,
    plan,
    navigation: { openTerminal, openAgent: vi.fn(), openWorkspace: vi.fn() },
  });
  expect(mocks.client).toHaveBeenCalledWith("linux");
  expect(mocks.terminal).toHaveBeenCalledWith({
    workspaceId: "remote-workspace",
    cwd: plan.cwd,
    name: tool.name,
    command: plan.command,
    args: plan.args,
  });
  expect(openTerminal).not.toHaveBeenCalled();
  expect(value.endpoint).toEqual({
    kind: "terminal",
    agentId: "original-process",
    cwd: plan.cwd,
    workspaceId: "remote-workspace",
  });
  await value.open();
  expect(openTerminal).toHaveBeenCalledWith({
    serverId: "linux",
    workspaceId: "remote-workspace",
    terminalId: "original-process",
  });
});
it("keeps a tokenized web address out of durable endpoint metadata and opens a private browser", async () => {
  const openBrowser = vi.fn();
  const url = "http://127.0.0.1:8123/?k=fixture-only";
  const value = await prepareOriginalView({
    serverId: "linux",
    tool,
    plan: { ...plan, mode: "web", command: undefined, url },
    navigation: { openBrowser, openAgent: vi.fn(), openWorkspace: vi.fn() },
  });
  expect(JSON.stringify(value.endpoint)).not.toContain("fixture-only");
  expect(value.endpoint).not.toHaveProperty("url");
  expect(mocks.terminal).not.toHaveBeenCalled();
  await value.open();
  expect(openBrowser).toHaveBeenCalledWith({
    url,
    workspaceId: "remote-workspace",
    serverId: "linux",
    ephemeral: true,
  });
});
it("fails before creating work when the host cannot open the requested original interface", async () => {
  await expect(
    prepareOriginalView({ serverId: "linux", tool, plan, navigation: undefined }),
  ).rejects.toThrow("cannot open original tool terminals");
  await expect(
    prepareOriginalView({
      serverId: "linux",
      tool,
      plan: { ...plan, url: "http://127.0.0.1:8123", mode: "web" },
      navigation: undefined,
    }),
  ).rejects.toThrow("desktop app");
  expect(mocks.workspace).not.toHaveBeenCalled();
  expect(mocks.terminal).not.toHaveBeenCalled();
});
