/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceBrowser, useBrowserStore } from "@/desktop/browser/store";
import { createDefaultLayout } from "@/stores/workspace-layout-store";
import { FOCUSED_PANE_PLACEMENT, openTabInLayoutFocused } from "@/stores/workspace-layout-actions";
import { useDesktopBrowserNewTabRequests } from ".";

const bridge = vi.hoisted(() => ({ listener: null as ((payload: unknown) => void) | null }));
vi.mock("@/constants/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/platform")>()),
  getIsElectron: () => true,
}));
vi.mock("@/desktop/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/desktop/host")>()),
  getDesktopHost: () => ({
    events: {
      on: (_event: string, handler: (payload: unknown) => void) => {
        bridge.listener = handler;
        return () => {
          bridge.listener = null;
        };
      },
    },
  }),
}));

describe("private browser new-tab propagation", () => {
  it("passes source privacy through popup handling and ignores closed sources", () => {
    const source = createWorkspaceBrowser({ initialUrl: "http://localhost:3210", ephemeral: true });
    const workspaceLayout = openTabInLayoutFocused({
      layout: createDefaultLayout(),
      target: { kind: "browser", browserId: source.browserId },
      now: 1,
      placement: FOCUSED_PANE_PLACEMENT,
      explorerSidebarPaneId: null,
    })!.layout;
    const openUrl = vi.fn();
    const mounted = renderHook(() =>
      useDesktopBrowserNewTabRequests({ enabled: true, workspaceLayout, openUrl }),
    );
    try {
      act(() =>
        bridge.listener?.({
          sourceBrowserId: source.browserId,
          url: "http://localhost:3210/?token=fake",
        }),
      );
      expect(openUrl).toHaveBeenCalledWith("http://localhost:3210/?token=fake", {
        ephemeral: true,
      });
      useBrowserStore.getState().removeBrowser(source.browserId);
      act(() =>
        bridge.listener?.({ sourceBrowserId: source.browserId, url: "https://example.com" }),
      );
      expect(openUrl).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
      useBrowserStore.getState().removeBrowser(source.browserId);
    }
  });
});
