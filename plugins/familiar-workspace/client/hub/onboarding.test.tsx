// @vitest-environment jsdom
import { createElement, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubOnboarding, useOnboarding, type OnboardingState } from "./onboarding.js";
import { readSetupDraft, setupReadiness, type SetupDraft } from "./onboarding-state.js";
import type { HubController } from "./controller.js";
import type { HubUi } from "./ui.js";
import type { ToolSetupStatus } from "../../shared/tool-setup.js";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../fleet.js", () => ({ hostRpc: (...args: unknown[]) => mocks.rpc(...args) }));
vi.mock("react-native", () => ({
  View: "div",
  Text: "span",
  ScrollView: "div",
  Modal: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./tool-guide.js", () => ({
  ToolGuide: ({ tool }: { tool: { name: string } }) =>
    createElement("span", {}, `About ${tool.name}`),
}));
vi.mock("./ui.js", () => ({
  ROW: {},
  HubPicker: ({
    label,
    value,
    options,
    onChange,
  }: {
    label: string;
    value: string;
    options: { id: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    createElement(
      "select",
      {
        "aria-label": label,
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
      },
      options.map((option) =>
        createElement("option", { key: option.id, value: option.id }, option.label),
      ),
    ),
}));
const ui = {
  colors: {},
  button: (label: string, click: () => void, disabled = false) =>
    createElement("button", { type: "button", onClick: click, disabled }, label),
  field: (label: string, value: string, onChange: (value: string) => void) =>
    createElement("input", {
      "aria-label": label,
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    }),
} as unknown as HubUi;
const hosts = [{ serverId: "mac", label: "Mac", status: "online" }];
function hub() {
  return {
    host: { id: "catalog" },
    target: "mac",
    cwd: "/project",
    online: hosts,
    hosts,
    catalogLoaded: true,
    projects: [],
    catalogTotal: 0,
    session: null,
    setupTarget: null,
    tools: ["codex", "goose", "agents"].map((id) => ({
      serverId: "mac",
      tool: { id, name: id, installed: true, nativeProvider: id === "codex" ? "codex" : undefined },
    })),
    fleet: [],
    openSetup: vi.fn(),
    askSetup: vi.fn(),
    useSetupTool: vi.fn(),
  } as unknown as HubController;
}
function status(id: string, account: ToolSetupStatus["account"] = "signed-in"): ToolSetupStatus {
  return {
    toolId: id,
    installation: "installed",
    account,
    checkedAt: "now",
    message: "Original account checked",
    details: [],
    actions: [],
  };
}
beforeEach(() => {
  localStorage.clear();
  mocks.rpc.mockReset().mockImplementation(async (_server, _contract, input) => status(input.id));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("does not interrupt existing projects or explicit entries, and skips repeated login for first use", async () => {
  const existing = { ...hub(), projects: [{ id: "existing" }] } as HubController;
  const first = renderHook(() => useOnboarding(existing));
  expect(first.result.current.visible).toBe(false);
  expect(mocks.rpc).not.toHaveBeenCalled();
  first.unmount();
  const explicit = renderHook(() => useOnboarding(hub(), true));
  expect(explicit.result.current.visible).toBe(false);
  expect(mocks.rpc).not.toHaveBeenCalled();
  explicit.unmount();
  const fresh = hub();
  const signed = renderHook(() => useOnboarding(fresh));
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(signed.result.current.visible).toBe(true));
  expect(signed.result.current.draft.step).toBe(2);
  expect(signed.result.current.draft.serverId).toBe("mac");
});
it("opens for verified first use without installed native accounts and persists dismissal", async () => {
  mocks.rpc.mockImplementation(async (_server, _contract, input) => ({
    ...status(input.id, "not-checked"),
    installation: "missing",
  }));
  const fresh = hub();
  const first = renderHook(() => useOnboarding(fresh));
  await waitFor(() => expect(first.result.current.visible).toBe(true));
  act(() => first.result.current.close());
  expect(readSetupDraft("catalog")?.dismissed).toBe(true);
  first.unmount();
  mocks.rpc.mockClear();
  const again = renderHook(() => useOnboarding(fresh));
  expect(again.result.current.visible).toBe(false);
  expect(mocks.rpc).not.toHaveBeenCalled();
  act(() => again.result.current.open());
  expect(again.result.current.visible).toBe(true);
});
it("late first-use checks cannot reopen a wizard dismissed by the user", async () => {
  let finish!: (value: ToolSetupStatus) => void;
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const fresh = hub();
  const { result } = renderHook(() => useOnboarding(fresh));
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
  act(() => {
    result.current.open();
    result.current.close();
  });
  await act(async () => finish({ ...status("codex", "not-checked"), installation: "missing" }));
  expect(result.current.visible).toBe(false);
});
it("selects multiple tools and sends one explicit request, then shows truthful account checks", async () => {
  const controller = hub();
  const close = vi.fn();
  function Flow() {
    const [draft, setDraft] = useState<SetupDraft>({
      serverId: "mac",
      toolIds: [],
      step: 2,
      dismissed: false,
    });
    const state = {
      visible: true,
      draft,
      update: (next: Partial<SetupDraft>) => setDraft((old) => ({ ...old, ...next })),
      open: vi.fn(),
      close,
    };
    return createElement(HubOnboarding, { hub: controller, ui, state });
  }
  mocks.rpc.mockImplementation(async (_server, _contract, input) =>
    status(input.id, input.id === "goose" ? "sign-in-required" : "not-checked"),
  );
  render(createElement(Flow));
  fireEvent.click(screen.getByText("goose"));
  fireEvent.click(screen.getByText("agents"));
  expect(controller.askSetup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Choose setup agent"));
  expect(controller.askSetup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Ask selected agent"));
  await waitFor(() => expect(controller.askSetup).toHaveBeenCalledTimes(1));
  expect(controller.askSetup).toHaveBeenCalledWith(
    "mac",
    expect.objectContaining({ id: "goose" }),
    { provider: "codex", cwd: "/project", tools: ["goose", "agents"] },
  );
  await screen.findByText("Installed · sign in needed");
  expect(screen.getByText("Installed · account not verified")).toBeTruthy();
  expect((screen.getByText("Use goose") as HTMLButtonElement).disabled).toBe(true);
  expect(controller.useSetupTool).not.toHaveBeenCalled();
});
it("cannot advance an installed but unauthenticated provider and offers native sign-in", async () => {
  const controller = hub();
  const state = {
    visible: true,
    draft: { serverId: "mac", toolIds: [], step: 1, dismissed: false },
    update: vi.fn(),
    close: vi.fn(),
    open: vi.fn(),
  } as OnboardingState;
  mocks.rpc.mockImplementation(async (_server, _contract, input) =>
    status(input.id, "sign-in-required"),
  );
  render(createElement(HubOnboarding, { hub: controller, ui, state }));
  await waitFor(() =>
    expect((screen.getByText("Connect Codex") as HTMLButtonElement).disabled).toBe(false),
  );
  expect((screen.getByText("Continue to choose tools") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Connect Codex"));
  expect(controller.openSetup).toHaveBeenCalledWith("mac", "codex");
  expect(controller.askSetup).not.toHaveBeenCalled();
});
it("navigation preferences tolerate unavailable storage without claiming readiness", () => {
  vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  const fresh = hub();
  const { result } = renderHook(() => useOnboarding(fresh, true));
  act(() => {
    result.current.open();
    result.current.update({ step: 3 });
    result.current.close();
  });
  expect(result.current.draft.step).toBe(3);
  expect(setupReadiness(status("goose", "not-checked"))).toBe("Installed · account not verified");
});

it("shows first-use connection guidance when account checks fail, instead of silently hiding setup", async () => {
  mocks.rpc.mockRejectedValue(new Error("Account check unavailable"));
  const fresh = hub();
  const { result } = renderHook(() => useOnboarding(fresh));
  await waitFor(() => expect(result.current.visible).toBe(true));
  expect(result.current.draft.step).toBe(1);
});

it("restarts a cancelled first-use probe when the connected fleet changes", async () => {
  let finish!: (value: ToolSetupStatus) => void;
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const fresh = hub();
  const { result, rerender } = renderHook(({ controller }) => useOnboarding(controller), {
    initialProps: { controller: fresh },
  });
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
  const expanded = {
    ...fresh,
    online: [...fresh.online, { serverId: "linux", label: "Linux", status: "online" }],
  } as HubController;
  rerender({ controller: expanded });
  await waitFor(() => expect(result.current.visible).toBe(true));
  expect(result.current.draft.step).toBe(2);
  await act(async () => finish(status("codex", "sign-in-required")));
  expect(result.current.draft.step).toBe(2);
});
it("allows a ready provider immediately while another check is pending, without locking close or server choice", async () => {
  let finish!: (value: ToolSetupStatus) => void;
  mocks.rpc.mockImplementation((_server, _contract, input) =>
    input.id === "codex"
      ? Promise.resolve(status("codex", "signed-in"))
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const controller = hub();
  const update = vi.fn();
  const close = vi.fn();
  const state = {
    visible: true,
    draft: { serverId: "mac", toolIds: [], step: 1, dismissed: false },
    update,
    open: vi.fn(),
    close,
  };
  render(createElement(HubOnboarding, { hub: controller, ui, state }));
  await waitFor(() =>
    expect((screen.getByText("Continue to choose tools") as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByText("Continue to choose tools"));
  expect(update).toHaveBeenCalledWith({ step: 2 });
  expect((screen.getByText("Connect Claude Code") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByText("Close — continue later"));
  expect(close).toHaveBeenCalledOnce();
  await act(async () => finish(status("claude", "not-checked")));
});
it("retries an unavailable tool catalog inside the setup dialog for only the chosen server", () => {
  const controller = hub();
  controller.tools = [];
  controller.reloadTools = vi.fn().mockResolvedValue(undefined);
  controller.toolCatalogErrors = { mac: "Mac catalog timed out" };
  controller.loadingToolServers = [];
  const state = {
    visible: true,
    draft: { serverId: "mac", toolIds: [], step: 2, dismissed: false },
    update: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  };
  render(createElement(HubOnboarding, { hub: controller, ui, state }));
  expect(screen.getByText("Mac catalog timed out")).toBeTruthy();
  fireEvent.click(screen.getByText("Retry tool catalog"));
  expect(controller.reloadTools).toHaveBeenCalledWith("mac");
});
