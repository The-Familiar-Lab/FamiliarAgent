// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdvisorChat } from "./advisor-chat.js";
import type { AdvisorSnapshot } from "./advisor-conversation.js";
import type { HubUi } from "./ui.js";
const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  getPaseoClient: () => ({ agents: { ref: () => ({ messageReceipt: mocks.receipt }) } }),
}));
vi.mock("./advisor-conversation.js", () => ({
  observeAdvisor: (...args: unknown[]) => mocks.observe(...args),
  sendAdvisorQuestion: (...args: unknown[]) => mocks.send(...args),
}));
vi.mock("react-native", () => ({ View: "div", Text: "span" }));
const ui = {
  colors: {},
  button: (text: string, onClick: () => void, disabled = false) =>
    createElement("button", { type: "button", onClick, disabled }, text),
  field: (label: string, value: string, change: (value: string) => void) =>
    createElement("input", {
      "aria-label": label,
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => change(event.target.value),
    }),
} as unknown as HubUi;
let snapshot: (value: AdvisorSnapshot) => void;
const idle = {
  messages: [{ id: "one", role: "Ask Familiar", text: "Use the installed native tool." }],
  agent: {
    id: "advisor",
    provider: "codex",
    model: "supported",
    status: "idle",
    pendingPermissions: [],
  },
  error: "",
  truncated: false,
} as unknown as AdvisorSnapshot;
const identity = { serverId: "remote", agentId: "advisor" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.observe.mockImplementation((_agent, update) => {
    snapshot = update;
    return mocks.stop;
  });
  mocks.send.mockResolvedValue({ state: "accepted", messageId: "two", text: "Follow-up" });
});
afterEach(cleanup);
it("keeps follow-up on the same native advisor, waits for approval, and only opens the main UI explicitly", async () => {
  const open = vi.fn();
  render(
    <AdvisorChat identity={identity} ui={ui} visible initialPending={false} openFull={open} />,
  );
  act(() => snapshot(idle));
  expect(screen.getByText("Use the installed native tool.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Ask a follow-up"), { target: { value: "Follow-up" } });
  act(() =>
    snapshot({
      ...idle,
      agent: { ...idle.agent!, pendingPermissions: [{ id: "approval" }] as never },
    }),
  );
  expect((screen.getByText("Send to advisor") as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Open full conversation"));
  expect(open).toHaveBeenCalledOnce();
  act(() => snapshot(idle));
  fireEvent.click(screen.getByText("Send to advisor"));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({ messageReceipt: mocks.receipt }),
    "Follow-up",
  );
});
it("keeps unknown delivery across hide/reopen and only reads its receipt", async () => {
  const delivery = {
    state: "unknown" as const,
    messageId: "pending",
    text: "Original question",
    error: "Connection lost",
  };
  const props = { identity, ui, initialPending: false, initialDelivery: delivery };
  const view = render(<AdvisorChat {...props} visible />);
  act(() => snapshot(idle));
  view.rerender(<AdvisorChat {...props} visible={false} />);
  expect(mocks.stop).toHaveBeenCalledOnce();
  view.rerender(<AdvisorChat {...props} visible />);
  act(() => snapshot(idle));
  mocks.receipt.mockResolvedValue({ state: "pending" });
  fireEvent.click(screen.getByText("Check delivery"));
  await waitFor(() =>
    expect(mocks.receipt).toHaveBeenCalledWith("pending", {
      text: "Original question",
      activeTurnBehavior: "reject",
    }),
  );
  expect(mocks.send).not.toHaveBeenCalled();
  expect(screen.getByText(/Delivery is still uncertain/)).toBeTruthy();
});
