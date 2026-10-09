// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubController } from "./controller.js";
import type { HubUi } from "./ui.js";
import { ToolSetupDialog } from "./tool-setup.js";
import { HubWorkspace } from "./workspace.js";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), open: vi.fn(), terminal: vi.fn() }));
vi.mock("react-native", () => ({
  View: "div",
  Text: "span",
  ScrollView: "div",
  Modal: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../fleet.js", () => ({ hostRpc: (...args: unknown[]) => mocks.rpc(...args) }));
vi.mock("@getpaseo/plugin/client", () => ({
  getPaseoClient: () => ({
    workspaces: { open: mocks.open },
    terminals: { create: mocks.terminal },
  }),
}));
vi.mock("./ui.js", () => ({
  ROW: {},
  HubTargetPicker: () => null,
  HubPicker: () => null,
  HubDisclosure: () => null,
}));
vi.mock("./tool-guide.js", () => ({ ToolGuide: () => null }));
const ui = {
  colors: {},
  button: (label: string, click: () => void, disabled = false) =>
    createElement("button", { type: "button", disabled, onClick: click }, label),
  field: () => null,
} as unknown as HubUi;
const tool = { id: "goose", name: "Goose", installed: false, modes: ["terminal"] };
const hub = {
  tools: [{ serverId: "linux", tool }],
  target: "linux",
  tab: "Sessions",
  cwd: "",
  toolId: "goose",
  models: [],
  session: { id: "same-A", title: "Current session", endpoints: [] },
  hosts: [{ serverId: "linux", label: "Ubuntu", status: "online" }],
  fleet: [],
  selectedTool: tool,
  setupTarget: { serverId: "linux", toolId: "goose" },
  hostName: () => "Ubuntu",
  setTools: vi.fn(),
  setSetupTarget: vi.fn(),
  setTarget: vi.fn(),
  setToolId: vi.fn(),
  setTab: vi.fn(),
  setNotice: vi.fn(),
  openSetup: vi.fn(),
  rememberSetupReturn: vi.fn(),
  navigation: { openTerminal: vi.fn() },
} as unknown as HubController;
beforeEach(() => {
  mocks.rpc.mockImplementation(async (_host, contract) => {
    if (contract.name === "tools.setup.status")
      return {
        toolId: "goose",
        installation: "missing",
        account: "not-checked",
        message: "Install on Ubuntu",
        details: [],
        actions: [{ id: "install", label: "Install" }],
      };
    if (contract.name === "tools.list") return [tool];
    if (contract.name === "tools.setup.prepare")
      return { plan: { cwd: "/private/setup", command: "/native/installer", args: ["fixed"] } };
    throw new Error(contract.name);
  });
  mocks.open.mockResolvedValue({ id: "setup-workspace" });
  mocks.terminal.mockResolvedValue({ id: "install-terminal" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("missing session tools are clickable and open setup instead of a disabled no-op", () => {
  render(createElement(HubWorkspace, { hub, ui, props: {} as never }));
  fireEvent.click(screen.getByText("Continue with another tool"));
  fireEvent.click(screen.getByText("Set up this tool"));
  expect(hub.openSetup).toHaveBeenCalledWith("linux", "goose");
});
it("installs on the chosen server without a project folder and retains the logical session", async () => {
  render(createElement(ToolSetupDialog, { hub, ui }));
  await screen.findByText("Install on Ubuntu");
  expect((screen.getByText("Use in this session") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Install"));
  await waitFor(() => expect(mocks.terminal).toHaveBeenCalled());
  expect(hub.rememberSetupReturn).toHaveBeenCalledWith("linux", "goose");
  expect(vi.mocked(hub.rememberSetupReturn).mock.invocationCallOrder[0]).toBeLessThan(
    mocks.open.mock.invocationCallOrder[0]!,
  );
  expect(mocks.rpc).toHaveBeenCalledWith(
    "linux",
    expect.objectContaining({ name: "tools.setup.prepare" }),
    { id: "goose", action: "install" },
  );
  expect(mocks.terminal).toHaveBeenCalledWith({
    workspaceId: "setup-workspace",
    cwd: "/private/setup",
    name: "Goose · install",
    command: "/native/installer",
    args: ["fixed"],
  });
  await waitFor(() => expect(hub.setSetupTarget).toHaveBeenCalledWith(null));
  expect(hub.session?.id).toBe("same-A");
  expect(hub.navigation?.openTerminal).toHaveBeenCalledWith({
    serverId: "linux",
    workspaceId: "setup-workspace",
    terminalId: "install-terminal",
  });
});
it("does not treat starting the installer as installation success", async () => {
  render(createElement(ToolSetupDialog, { hub, ui }));
  await screen.findByText("Install on Ubuntu");
  expect(screen.getByText(/Account: not checked/)).toBeTruthy();
  fireEvent.click(screen.getByText("Check setup"));
  await waitFor(() =>
    expect(
      mocks.rpc.mock.calls.filter((call) => call[1].name === "tools.setup.status"),
    ).toHaveLength(2),
  );
  expect((screen.getByText("Use in this session") as HTMLButtonElement).disabled).toBe(true);
});
it("cancelled key entry or terminal failure cannot replace saved credentials", async () => {
  const selected = {
    ...hub,
    setupTarget: { serverId: "linux", toolId: "aider" },
    tools: [{ serverId: "linux", tool: { ...tool, id: "aider", name: "Aider" } }],
  } as HubController;
  mocks.rpc.mockImplementation(async (_host, contract) => {
    if (contract.name === "tools.setup.status")
      return {
        toolId: "aider",
        installation: "installed",
        account: "not-checked",
        message: "Choose provider",
        details: [],
        actions: [{ id: "api-key", label: "Add API key" }],
      };
    if (contract.name === "tools.list") return selected.tools.map((item) => item.tool);
    if (contract.name === "tools.setup.prepare")
      return {
        plan: { cwd: "/setup", command: "/python3", args: ["hidden-input-helper"] },
        credentialFile: "/private/new.env",
      };
    throw new Error(contract.name);
  });
  mocks.terminal.mockRejectedValue(new Error("Terminal unavailable"));
  render(createElement(ToolSetupDialog, { hub: selected, ui }));
  await screen.findByText("Choose provider");
  fireEvent.click(screen.getByText("Add API key"));
  await screen.findByText("Terminal unavailable");
  expect(mocks.rpc.mock.calls.some((call) => call[1].name === "tools.action-settings.save")).toBe(
    false,
  );
  expect(mocks.rpc.mock.calls.some((call) => call[1].name.includes("settings"))).toBe(false);
});

it("registers skills-only setup with the current resource revision and opens no terminal", async () => {
  const original = mocks.rpc.getMockImplementation()!;
  const skills = [{ id: "docker-specialist", path: "/original/skills/docker", enabled: true }];
  mocks.rpc.mockImplementation(async (host, contract, input) => {
    if (contract.name === "tools.setup.prepare") return { skills };
    if (contract.name === "resources.list") return { revision: 7, skills: [], mcp: [] };
    if (contract.name === "resources.use-skills")
      return { status: "added", resources: { revision: 8, skills, mcp: [] } };
    return original(host, contract, input);
  });
  render(createElement(ToolSetupDialog, { hub, ui }));
  await screen.findByText("Install on Ubuntu");
  fireEvent.click(screen.getByText("Install"));
  await screen.findByText(/Skills registered on this server/);
  expect(mocks.rpc).toHaveBeenCalledWith(
    "linux",
    expect.objectContaining({ name: "resources.use-skills" }),
    { expectedRevision: 7, skills },
  );
  expect(mocks.terminal).not.toHaveBeenCalled();
});
it("offers another server's installation without claiming its account is authenticated", async () => {
  const available = {
    ...hub,
    hosts: [...hub.hosts, { serverId: "mac", status: "online", label: "Mac" }],
    tools: [...hub.tools, { serverId: "mac", tool: { ...tool, installed: true } }],
    hostName: (id: string) => (id === "mac" ? "Mac" : "Ubuntu"),
  } as HubController;
  render(createElement(ToolSetupDialog, { hub: available, ui }));
  await screen.findByText("Install on Ubuntu");
  fireEvent.click(screen.getByText("Use installation on Mac"));
  expect(hub.openSetup).toHaveBeenCalledWith("mac", "goose");
  expect(hub.setNotice).toHaveBeenCalledWith(expect.stringContaining("Choose or link"));
  expect(screen.getByText(/Installation does not confirm sign-in/)).toBeTruthy();
});
it("can close a pending status read and ignores its late response", async () => {
  let complete!: (value: unknown) => void;
  mocks.rpc.mockImplementation((_host, contract) =>
    contract.name === "tools.list"
      ? Promise.resolve([tool])
      : new Promise((resolve) => {
          complete = resolve;
        }),
  );
  const view = render(createElement(ToolSetupDialog, { hub, ui }));
  const close = screen.getByText("Close") as HTMLButtonElement;
  expect(close.disabled).toBe(false);
  fireEvent.click(close);
  expect(hub.setSetupTarget).toHaveBeenCalledWith(null);
  view.unmount();
  complete({ installation: "installed", account: "signed-in", details: [], actions: [] });
});
