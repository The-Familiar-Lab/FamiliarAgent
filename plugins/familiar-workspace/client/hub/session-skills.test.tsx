// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionSkills } from "./session-skills.js";
import type { HubController } from "./controller.js";
import type { HubUi } from "./ui.js";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../fleet.js", () => ({
  hostRpc: (...args: unknown[]) => mocks.rpc(...args),
  operationId: () => "selected-skill",
}));
vi.mock("react-native", () => ({ View: "div", Text: "span" }));
vi.mock("./context-help.js", () => ({
  ContextHelp: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement("details", {}, createElement("summary", {}, label), children),
  ContextToggle: ({
    label,
    checked,
    disabled,
    onPress,
  }: {
    label: string;
    checked: boolean;
    disabled: boolean;
    onPress: () => void;
  }) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": label,
      checked,
      disabled,
      onChange: onPress,
    }),
}));
const ui = {
  button: (label: string, onClick: () => void, disabled = false) =>
    createElement("button", { type: "button", onClick, disabled }, label),
} as unknown as HubUi;
function controller() {
  return {
    host: { id: "catalog" },
    session: {
      id: "A",
      title: "Current",
      revision: 2,
      memoryEnabled: true,
      resources: [],
      disabledResourceIds: [],
    },
    hosts: [
      { serverId: "mac", connection: undefined },
      { serverId: "remote", connection: "ssh://remote" },
    ],
    hostName: (id: string) => id,
    resourceCatalog: [
      {
        serverId: "mac",
        label: "Mac",
        value: { skills: [{ id: "review", path: "/mac/review", enabled: true }] },
      },
      {
        serverId: "remote",
        label: "Linux",
        value: { skills: [{ id: "review", path: "/linux/review", enabled: false }] },
      },
    ],
    saveSessionPreferences: vi.fn().mockResolvedValue({}),
    setNotice: vi.fn(),
    run: (action: () => Promise<void>) => action(),
  } as unknown as HubController;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (_owner, contract) => {
    if (contract.name === "composition.context") return { resources: [], truncated: false };
    return { text: "Original instructions", truncated: false };
  });
});
afterEach(cleanup);
it("combines owner libraries and selects only a pointer for this session regardless of global defaults", async () => {
  const hub = controller();
  render(<SessionSkills hub={hub} ui={ui} />);
  const remote = screen.getByLabelText("review · Linux") as HTMLInputElement;
  await waitFor(() => expect(remote.disabled).toBe(false));
  expect(remote.checked).toBe(false);
  fireEvent.click(remote);
  await waitFor(() =>
    expect(hub.saveSessionPreferences).toHaveBeenCalledWith({
      memoryEnabled: true,
      disabledResourceIds: [],
      resources: [
        {
          id: "selected-skill",
          kind: "skill",
          format: "path",
          label: "review",
          serverId: "remote",
          connection: "ssh://remote",
          locator: "review",
          readOnly: true,
        },
      ],
    }),
  );
  expect(
    mocks.rpc.mock.calls.every(([, contract]) => contract.name === "composition.context"),
  ).toBe(true);
  expect(screen.getByText("/linux/review")).toBeTruthy();
  expect(screen.getByText("/mac/review")).toBeTruthy();
});
it("stops inherited skill access locally and reads preview from the exact owner only on demand", async () => {
  const inherited = {
    id: "parent-skill",
    kind: "skill",
    format: "path",
    locator: "review",
    serverId: "remote",
    readOnly: true,
  };
  mocks.rpc.mockImplementation(async (_owner, contract) =>
    contract.name === "composition.context"
      ? { resources: [inherited], truncated: false }
      : { text: "Original instructions", truncated: false },
  );
  const hub = controller();
  render(<SessionSkills hub={hub} ui={ui} />);
  const remote = screen.getByLabelText("review · Linux") as HTMLInputElement;
  await waitFor(() => expect(remote.checked).toBe(true));
  fireEvent.click(remote);
  await waitFor(() =>
    expect(hub.saveSessionPreferences).toHaveBeenCalledWith({
      resources: [],
      disabledResourceIds: ["parent-skill"],
      memoryEnabled: true,
    }),
  );
  fireEvent.click(screen.getAllByText("Preview original instructions")[1]!);
  await waitFor(() =>
    expect(mocks.rpc).toHaveBeenCalledWith(
      "remote",
      expect.objectContaining({ name: "resources.skill.read" }),
      { id: "review", maxCharacters: 4096 },
    ),
  );
  expect(await screen.findByText("Original instructions")).toBeTruthy();
});
it("memory checkbox preserves references and ignores a previous session's late context", async () => {
  const hub = controller();
  let resolve!: (value: unknown) => void;
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<SessionSkills hub={hub} ui={ui} />);
  const next = controller();
  Object.assign(next, {
    session: {
      ...hub.session!,
      id: "B",
      title: "Other",
      memoryEnabled: false,
      resources: [
        {
          id: "history",
          kind: "history",
          format: "native-timeline",
          locator: "native",
          serverId: "mac",
          readOnly: true,
        },
      ],
    },
  });
  view.rerender(<SessionSkills hub={next} ui={ui} />);
  await waitFor(() =>
    expect((screen.getByLabelText("review · Linux") as HTMLInputElement).disabled).toBe(false),
  );
  await act(async () =>
    resolve({
      resources: [
        { id: "late", kind: "skill", format: "path", locator: "review", serverId: "remote" },
      ],
      truncated: false,
    }),
  );
  expect((screen.getByLabelText("review · Linux") as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText("Shared project and session memory"));
  await waitFor(() =>
    expect(next.saveSessionPreferences).toHaveBeenCalledWith({
      memoryEnabled: true,
      disabledResourceIds: [],
      resources: next.session!.resources,
    }),
  );
});
