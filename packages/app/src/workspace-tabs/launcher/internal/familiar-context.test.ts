import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
import { WorkspaceLayoutPersistedStateSchema } from "@/stores/workspace-layout-storage";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/workspace-tabs/identity";
import { familiarHubTarget, resolveFamiliarAgent } from "./familiar-context";

function pane(id: string, targets: WorkspaceTabTarget[], active = targets.length - 1) {
  const tabs: WorkspaceTab[] = targets.map((target, i) => ({
    tabId: `${id}-${i}`,
    target,
    createdAt: i,
  }));
  return {
    kind: "pane" as const,
    pane: {
      id,
      tabIds: tabs.map((tab) => tab.tabId),
      focusedTabId: tabs[active]?.tabId ?? null,
      tabs,
    },
  };
}
const chat = { kind: "agent", agentId: "original-A" } as const;
const fresh = { kind: "new_tab" } as const;

describe("Familiar supporting panel context", () => {
  it("inherits the still-visible main conversation when the side New tab owns focus", () => {
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "root",
          direction: "horizontal",
          sizes: [70, 30],
          children: [pane("main", [chat]), pane("side", [fresh])],
        },
      },
      focusedPaneId: "side",
    };
    expect(resolveFamiliarAgent({ serverId: "linux", layout, tabId: "side-0" })).toBe("original-A");
  });
  it("uses the originating tab for a new main tab, not an arbitrary inactive conversation", () => {
    const layout: WorkspaceLayout = {
      root: pane("main", [chat, { kind: "agent", agentId: "unrelated" }, fresh]),
      focusedPaneId: "main",
      parentTabIdByTabId: { "main-2": "main-0" },
    };
    expect(resolveFamiliarAgent({ serverId: "linux", layout, tabId: "main-2" })).toBe("original-A");
    expect(
      resolveFamiliarAgent({ serverId: "linux", layout: { ...layout, parentTabIdByTabId: {} } }),
    ).toBeUndefined();
  });
  it("does not guess between multiple visible conversations or borrow another host's params", () => {
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "root",
          direction: "horizontal",
          sizes: [40, 40, 20],
          children: [
            pane("one", [chat]),
            pane("two", [{ kind: "agent", agentId: "B" }]),
            pane("new", [fresh]),
          ],
        },
      },
      focusedPaneId: "new",
    };
    expect(resolveFamiliarAgent({ serverId: "linux", layout })).toBeUndefined();
    const foreign: WorkspaceLayout = {
      root: pane("main", [
        familiarHubTarget({ serverId: "mac", workspaceId: "work", agentId: "foreign" }),
      ]),
      focusedPaneId: "main",
    };
    expect(resolveFamiliarAgent({ serverId: "linux", layout: foreign })).toBeUndefined();
  });
  it.each(["goose", "openrig", "future-native-tool"])(
    "opens %s setup with exact native context, without an execute request",
    (toolId) => {
      const target = familiarHubTarget({
        serverId: "linux",
        workspaceId: "work",
        agentId: "original-A",
        cwd: "/workspace/source",
        toolId,
      });
      expect(target.params).toEqual({
        serverId: "linux",
        workspaceId: "work",
        agentId: "original-A",
        cwd: "/workspace/source",
        toolId,
        setup: "1",
      });
      expect(normalizeWorkspaceTabTarget(target)).toEqual(target);
      const stored = WorkspaceLayoutPersistedStateSchema.parse({
        layoutByWorkspace: {
          "linux:work": { root: pane("side", [target]), focusedPaneId: "side" },
        },
      });
      expect(stored.layoutByWorkspace["linux:work"]).toBeTruthy();
    },
  );
  it("keeps reordered params stable while separating a different agent or selected tool", () => {
    const first = familiarHubTarget({
      serverId: "linux",
      workspaceId: "work",
      agentId: "A",
      toolId: "goose",
    });
    const reordered = {
      ...first,
      params: Object.fromEntries(Object.entries(first.params!).toReversed()),
    };
    expect(workspaceTabTargetsEqual(first, reordered)).toBe(true);
    expect(buildDeterministicWorkspaceTabId(first)).toBe(
      buildDeterministicWorkspaceTabId(reordered),
    );
    for (const different of [
      familiarHubTarget({ serverId: "linux", workspaceId: "work", agentId: "B", toolId: "goose" }),
      familiarHubTarget({
        serverId: "linux",
        workspaceId: "work",
        agentId: "A",
        toolId: "openrig",
      }),
    ]) {
      expect(workspaceTabTargetsEqual(first, different)).toBe(false);
      expect(buildDeterministicWorkspaceTabId(first)).not.toBe(
        buildDeterministicWorkspaceTabId(different),
      );
    }
  });
});
