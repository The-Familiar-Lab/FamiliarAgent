/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTerminalWebView } from "@/terminal/runtime/use-terminal-web-view";
import { PaneFocusProvider, PaneProvider, type PaneContextValue } from "./pane-context";
import { terminalPanelRegistration } from "./terminal-panel";

interface CapturedTerminal {
  serverId: string;
  terminalId: string;
  cwd: string;
  onOpenWebView?: OpenTerminalWebView;
}
const mocks = vi.hoisted(() => ({
  terminal: null as CapturedTerminal | null,
  browsers: new Map<string, { url: string }>(),
  createBrowser: vi.fn(),
  updateBrowser: vi.fn(),
  prepare: vi.fn(),
  workspaceFields: vi.fn(),
  openTab: vi.fn(),
  retarget: vi.fn(),
  closeTab: vi.fn(),
  openHub: vi.fn(),
}));
vi.mock("@/components/terminal-pane", () => ({
  TerminalPane: (props: CapturedTerminal) => {
    mocks.terminal = props;
    return <div data-testid="original-terminal">{props.terminalId}</div>;
  },
}));
vi.mock("@/plugins/host-navigation", () => ({ prepareHostBrowserUrl: mocks.prepare }));
vi.mock("@/plugins/familiar-navigation", () => ({ openFamiliarHub: mocks.openHub }));
vi.mock("@/constants/platform", () => ({ getIsElectron: () => true }));
vi.mock("@/desktop/browser/store", () => ({
  createWorkspaceBrowser: mocks.createBrowser,
  getBrowserRecord: (id: string) => mocks.browsers.get(id) ?? null,
  useBrowserStore: { getState: () => ({ updateBrowser: mocks.updateBrowser }) },
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceFields: mocks.workspaceFields,
  useWorkspaceDirectory: () => "/original/project",
}));
vi.mock("@/stores/panel-store", () => ({ usePanelStore: () => vi.fn() }));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => null }));
vi.mock("@/data/query-client", () => ({ queryClient: {} }));
vi.mock("@/screens/workspace/terminals/state", () => ({ buildTerminalsQueryKey: () => [] }));

const sourceUrl = "http://127.0.0.1:43210/?k=test-private-key";
const forwardedUrl = "http://127.0.0.1:43211/?k=test-private-key";
const view = { title: "Pullboard", url: sourceUrl, preserveHost: true };
const context: PaneContextValue = {
  serverId: "ssh-server",
  workspaceId: "original-workspace",
  host: "main",
  tabId: "original-tab",
  target: { kind: "terminal", terminalId: "original-terminal" },
  openTab: mocks.openTab,
  closeCurrentTab: mocks.closeTab,
  retargetCurrentTab: mocks.retarget,
  openPreferredTarget: vi.fn(),
  setCurrentTabState: vi.fn(),
  openFileInWorkspace: vi.fn(),
  openImportSheet: vi.fn(),
};
const focus = {
  isWorkspaceFocused: true,
  isPaneFocused: true,
  isInteractive: true,
  focusPane: vi.fn(),
};

function mountTerminal() {
  const Component = terminalPanelRegistration.component;
  render(
    <PaneProvider value={context}>
      <PaneFocusProvider value={focus}>
        <Component />
      </PaneFocusProvider>
    </PaneProvider>,
  );
  const open = mocks.terminal?.onOpenWebView;
  if (!open) throw new Error("Terminal web navigation was not exposed");
  return open;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("React", React);
  mocks.terminal = null;
  mocks.browsers.clear();
  mocks.prepare.mockResolvedValue(forwardedUrl);
  mocks.workspaceFields.mockReturnValue({
    workspaceDirectory: "/original/project",
    isGitCheckout: true,
  });
  mocks.createBrowser.mockImplementation(({ initialUrl }: { initialUrl: string }) => {
    mocks.browsers.set("new-browser", { url: initialUrl });
    return { browserId: "new-browser", url: initialUrl };
  });
  mocks.updateBrowser.mockImplementation((id: string, patch: { url: string }) => {
    mocks.browsers.set(id, patch);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("terminal panel original web view", () => {
  it("returns to this original terminal's shared session on its owning server", () => {
    mountTerminal();
    fireEvent.click(screen.getByRole("button", { name: "View session activity" }));
    expect(mocks.openHub).toHaveBeenCalledWith({
      serverId: "ssh-server",
      workspaceId: "original-workspace",
      cwd: "/original/project",
      terminalId: "original-terminal",
    });
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });
  it("opens a private browser in the same workspace without replacing or closing its terminal", async () => {
    const open = mountTerminal();
    const prepared = await open(view, undefined, new AbortController().signal);
    expect(mocks.prepare).toHaveBeenCalledWith({
      serverId: "ssh-server",
      url: sourceUrl,
      preserveHost: true,
    });
    expect(mocks.createBrowser).toHaveBeenCalledWith({ initialUrl: forwardedUrl, ephemeral: true });
    expect(prepared.browserId).toBe("new-browser");
    expect(mocks.openTab).not.toHaveBeenCalled();
    act(() => prepared.show());
    expect(mocks.openTab).toHaveBeenCalledWith({ kind: "browser", browserId: "new-browser" });
    expect(mocks.workspaceFields).toHaveBeenCalledWith(
      "ssh-server",
      "original-workspace",
      expect.any(Function),
    );
    expect(screen.getByTestId("original-terminal").textContent).toBe("original-terminal");
    expect(mocks.terminal).toMatchObject({
      serverId: "ssh-server",
      cwd: "/original/project",
      terminalId: "original-terminal",
    });
    expect(mocks.retarget).not.toHaveBeenCalled();
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("updates a reused browser to the new SSH forwarding port before opening it", async () => {
    mocks.browsers.set("existing-browser", { url: sourceUrl });
    const open = mountTerminal();
    const prepared = await open(view, "existing-browser", new AbortController().signal);
    expect(mocks.createBrowser).not.toHaveBeenCalled();
    expect(mocks.updateBrowser).toHaveBeenCalledWith("existing-browser", { url: forwardedUrl });
    expect(prepared.browserId).toBe("existing-browser");
    expect(mocks.openTab).not.toHaveBeenCalled();
    act(() => prepared.show());
    expect(mocks.openTab).toHaveBeenCalledWith({ kind: "browser", browserId: "existing-browser" });
    expect(mocks.updateBrowser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openTab.mock.invocationCallOrder[0]!,
    );
  });

  it("does not create or open a browser when navigation is canceled during SSH preparation", async () => {
    let prepared!: (url: string) => void;
    mocks.prepare.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          prepared = resolve;
        }),
    );
    const open = mountTerminal();
    const controller = new AbortController();
    const pending = open(view, undefined, controller.signal);
    controller.abort();
    prepared(forwardedUrl);
    await expect(pending).rejects.toThrow("Terminal view closed");
    expect(mocks.createBrowser).not.toHaveBeenCalled();
    expect(mocks.updateBrowser).not.toHaveBeenCalled();
    expect(mocks.openTab).not.toHaveBeenCalled();
  });
});
