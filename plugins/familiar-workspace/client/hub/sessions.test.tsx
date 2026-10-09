// @vitest-environment jsdom
import { createElement } from "react";
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
import type { HubController } from "./controller.js";
import type { HubUi } from "./ui.js";
import type { SessionChoice, SessionPreview } from "./browse.js";
import { HubSessions, useSessionPreview } from "./sessions.js";
const mocks = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("react-native", () => ({
  View: "div",
  Text: "span",
  TextInput: "input",
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-label": accessibilityLabel },
      children,
    ),
}));
vi.mock("./browse.js", async (original) => ({
  ...(await original<typeof import("./browse.js")>()),
  readSessionPreview: mocks.preview,
}));
const ui = {
  colors: {},
  button: (label: string, click: () => void, disabled = false) =>
    createElement("button", { type: "button", onClick: click, disabled }, label),
  field: () => null,
} as unknown as HubUi;
const agent = {
  id: "native",
  title: "Native conversation",
  cwd: "/project",
  provider: "codex",
  model: "Model",
};
const hub = {
  host: { id: "mac" },
  hosts: [{ serverId: "mac", label: "Mac", status: "online" }],
  online: [{ serverId: "mac" }],
  sessions: [],
  projects: [],
  fleet: [{ server: { serverId: "mac", label: "Mac" }, agents: [agent] }],
  hostName: () => "Mac",
  query: "",
  filter: "all",
  catalogOffset: 0,
  catalogTotal: 0,
  attachNative: vi.fn(),
  selectSession: vi.fn(),
  run: async (action: () => Promise<void>) => action(),
} as unknown as HubController;
const preview: SessionPreview = {
  title: "Native conversation",
  endpoints: [],
  messages: [{ id: "1", role: "Assistant", text: "Review this response" }],
  note: "Nothing sent",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.preview.mockResolvedValue(preview);
});
afterEach(cleanup);
it("browsing and preview do not select or mutate until the explicit confirmation", async () => {
  render(createElement(HubSessions, { hub, ui }));
  expect(mocks.preview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("▸ project · Mac (1)"));
  fireEvent.click(screen.getByRole("button", { name: /Preview Native conversation/ }));
  await screen.findByText("Review this response");
  expect(hub.attachNative).not.toHaveBeenCalled();
  expect(hub.selectSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Select session"));
  await waitFor(() => expect(hub.attachNative).toHaveBeenCalledWith("mac", agent));
});
it("cancel keeps the current selection and stale async previews cannot replace the latest choice", async () => {
  let resolveFirst: ((value: SessionPreview) => void) | undefined;
  mocks.preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const first: SessionChoice = { kind: "shared", id: "first" };
  const second: SessionChoice = { kind: "shared", id: "second" };
  const { result, rerender } = renderHook(
    ({ choice }) => useSessionPreview("mac", choice, new Set(["mac"])),
    { initialProps: { choice: first } },
  );
  await waitFor(() => expect(resolveFirst).toBeDefined());
  rerender({ choice: second });
  await waitFor(() => expect(result.current.preview?.title).toBe("Native conversation"));
  await act(async () => resolveFirst!({ ...preview, title: "STALE" }));
  expect(result.current.preview?.title).toBe("Native conversation");
});
