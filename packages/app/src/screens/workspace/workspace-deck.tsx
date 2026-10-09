import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { RetainedPanel } from "@/components/retained-panel";
import { ResizeHandle } from "@/components/resize-handle";
import { useToast } from "@/contexts/toast-context";
import { isNative, isWeb } from "@/constants/platform";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useHasHydratedWorkspaces, useWorkspaceExists } from "@/stores/session-store-hooks";
import { useProjectViewStore, useProjectViewsHydrated } from "@/stores/project-view-store";
import { WorkspaceScreen } from "./workspace-screen";
import { ProjectViewsBar } from "./project-views-bar";
import {
  MAX_VISIBLE_PROJECT_VIEWS,
  showProjectView,
  visibleProjectViews,
  type ProjectDropPosition,
} from "./project-views";
import { computeProjectViewLayout, type ProjectViewRect } from "./project-view-layout";
import { ProjectViewDropTarget } from "./project-view-drop-target";
import {
  areRetainedWorkspaceSelectionListsEqual,
  areWorkspaceSelectionsEqual,
  getNextWorkspaceDeckExpirationDelay,
  getWorkspaceSelectionKey,
  reconcileRetainedWorkspaceSelections,
  resolveWorkspaceDeckRetentionLimit,
  shouldKeepWorkspaceDeckEntryMounted,
  type RetainedWorkspaceSelection,
} from "./workspace-deck-retention";

export function WorkspaceDeck({ recoveryRequested }: { recoveryRequested: boolean }) {
  const route = useActiveWorkspaceSelection();
  const activeServerId = route?.serverId;
  const activeWorkspaceId = route?.workspaceId;
  const active = useMemo(
    () =>
      activeServerId && activeWorkspaceId
        ? { serverId: activeServerId, workspaceId: activeWorkspaceId }
        : null,
    [activeServerId, activeWorkspaceId],
  );
  const hydrated = useProjectViewsHydrated();
  const saved = useProjectViewStore((store) => store.state);
  const state = useMemo(() => (active ? showProjectView(saved, active) : saved), [saved, active]);
  const visible = useMemo(() => visibleProjectViews(state, active, isNative), [state, active]);
  const [retained, setRetained] = useState<RetainedWorkspaceSelection[]>([]);
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const [preview, setPreview] = useState<{ splitId: string; sizes: number[] } | null>(null);
  const geometry = useMemo(
    () =>
      computeProjectViewLayout(
        isNative && active ? { kind: "leaf", key: getWorkspaceSelectionKey(active) } : state.layout,
        layout,
        preview,
      ),
    [active, state.layout, layout, preview],
  );
  const toast = useToast();
  useEffect(() => {
    if (hydrated && active) useProjectViewStore.getState().show(active);
  }, [hydrated, active]);
  const now = Date.now();
  const next = reconcileRetainedWorkspaceSelections({
    currentEntries: retained,
    activeSelection: active,
    visibleSelections: visible,
    now,
    maxMountedWorkspaces: resolveWorkspaceDeckRetentionLimit({ isNative }),
  });
  useLayoutEffect(() => {
    if (!areRetainedWorkspaceSelectionListsEqual(retained, next)) setRetained(next);
  }, [next, retained]);
  useEffect(() => {
    const delay = getNextWorkspaceDeckExpirationDelay({
      entries: next,
      activeSelection: active,
      now,
    });
    if (delay === null) return;
    const timer = setTimeout(
      () =>
        setRetained((currentEntries) =>
          reconcileRetainedWorkspaceSelections({
            currentEntries,
            activeSelection: active,
            visibleSelections: visible,
            now: Date.now(),
            maxMountedWorkspaces: resolveWorkspaceDeckRetentionLimit({ isNative }),
          }),
        ),
      delay + 1,
    );
    return () => clearTimeout(timer);
  }, [next, active, now, visible]);
  const remove = useCallback((selection: ActiveWorkspaceSelection) => {
    useProjectViewStore.getState().close(selection);
    setRetained((current) =>
      current.filter((entry) => !areWorkspaceSelectionsEqual(entry.selection, selection)),
    );
  }, []);
  // Geometry owns visual order; stable DOM order also preserves embedded iframe documents.
  const entries = [...next].sort((left, right) =>
    getWorkspaceSelectionKey(left.selection).localeCompare(
      getWorkspaceSelectionKey(right.selection),
    ),
  );
  const resizePreview = useCallback(
    (splitId: string, sizes: number[]) => setPreview({ splitId, sizes }),
    [],
  );
  const resize = useCallback((splitId: string, sizes: number[]) => {
    useProjectViewStore.getState().resize(splitId, sizes);
    setPreview(null);
  }, []);
  const dock = useCallback(
    (selection: ActiveWorkspaceSelection, targetKey: string, position: ProjectDropPosition) => {
      const store = useProjectViewStore.getState();
      if (getWorkspaceSelectionKey(selection) === targetKey) return;
      const before = store.state;
      store.dock(selection, targetKey, position);
      if (useProjectViewStore.getState().state === before) {
        toast.show(
          `Up to ${MAX_VISIBLE_PROJECT_VIEWS} projects fit in one view. Drop in the center to replace a pane.`,
        );
        return;
      }
      setPreview(null);
      navigateToWorkspace(selection);
    },
    [toast],
  );
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setLayout((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, []);
  return (
    <View style={styles.deck}>
      {active && hydrated ? <ProjectViewsBar active={active} state={state} /> : null}
      <View style={styles.deck} onLayout={onLayout} testID="project-view-deck">
        {entries.map(({ selection }) => {
          const key = getWorkspaceSelectionKey(selection);
          const rect = geometry.leaves.get(key);
          return (
            <WorkspaceDeckEntry
              key={key}
              selection={selection}
              active={areWorkspaceSelectionsEqual(selection, active)}
              visible={!!rect}
              rect={rect}
              recoveryRequested={recoveryRequested}
              onUnmountInactive={remove}
              onDock={dock}
            />
          );
        })}
        {geometry.dividers.map((divider) => (
          <View
            key={divider.id}
            style={[styles.divider, divider.rect, divider.direction === "horizontal" && styles.row]}
          >
            <ResizeHandle
              direction={divider.direction}
              groupId={divider.id}
              index={0}
              sizes={divider.sizes}
              containerSize={divider.containerSize}
              testID={`project-view-divider-${divider.id}`}
              onPreviewResizeSplit={resizePreview}
              onResizeSplit={resize}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

/** Capture focus before workspace handlers run; only the selected workspace owns shortcuts. */
export function ProjectViewFocus({
  active,
  visible,
  selection,
  children,
}: {
  active: boolean;
  visible: boolean;
  selection: ActiveWorkspaceSelection;
  children: ReactNode;
}) {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (!isWeb || active || !visible) return;
    const element = ref.current as unknown as HTMLElement | null;
    if (!element?.addEventListener) return;
    const focus = () => navigateToWorkspace(selection);
    element.addEventListener("pointerdown", focus, true);
    element.addEventListener("focusin", focus, true);
    return () => {
      element.removeEventListener("pointerdown", focus, true);
      element.removeEventListener("focusin", focus, true);
    };
  }, [active, visible, selection]);
  return (
    <View
      ref={ref}
      collapsable={false}
      style={styles.deck}
      testID={`project-view-focus-${getWorkspaceSelectionKey(selection)}`}
    >
      {children}
    </View>
  );
}

function WorkspaceDeckEntry({
  selection,
  active,
  visible,
  rect,
  recoveryRequested,
  onUnmountInactive,
  onDock,
}: {
  selection: ActiveWorkspaceSelection;
  active: boolean;
  visible: boolean;
  rect: ProjectViewRect | undefined;
  recoveryRequested: boolean;
  onUnmountInactive: (selection: ActiveWorkspaceSelection) => void;
  onDock: (
    selection: ActiveWorkspaceSelection,
    targetKey: string,
    position: ProjectDropPosition,
  ) => void;
}) {
  const hydrated = useHasHydratedWorkspaces(selection.serverId);
  const exists = useWorkspaceExists(selection.serverId, selection.workspaceId);
  const keep = shouldKeepWorkspaceDeckEntryMounted({
    isActive: active,
    hasHydratedWorkspaces: hydrated,
    workspaceExists: exists,
  });
  useEffect(() => {
    if (!keep) onUnmountInactive(selection);
  }, [keep, onUnmountInactive, selection]);
  const key = getWorkspaceSelectionKey(selection);
  const drop = useCallback(
    (source: ActiveWorkspaceSelection, position: ProjectDropPosition) =>
      onDock(source, key, position),
    [key, onDock],
  );
  if (!keep) return null;
  return (
    <RetainedPanel
      active={visible}
      style={[styles.entry, rect ?? StyleSheet.absoluteFillObject]}
      testID={`workspace-deck-entry-${getWorkspaceSelectionKey(selection)}`}
    >
      <ProjectViewDropTarget
        disabled={!visible || isNative}
        onDrop={drop}
        testID={`project-view-drop-${key}`}
      >
        <ProjectWorkspaceContent
          selection={selection}
          active={active}
          visible={visible}
          recoveryRequested={recoveryRequested}
        />
      </ProjectViewDropTarget>
    </RetainedPanel>
  );
}

// Keep heavy workspace contents independent of pointer-rate geometry previews.
const ProjectWorkspaceContent = memo(function ProjectWorkspaceContent({
  selection,
  active,
  visible,
  recoveryRequested,
}: {
  selection: ActiveWorkspaceSelection;
  active: boolean;
  visible: boolean;
  recoveryRequested: boolean;
}) {
  return (
    <ProjectViewFocus active={active} visible={visible} selection={selection}>
      <WorkspaceScreen
        serverId={selection.serverId}
        workspaceId={selection.workspaceId}
        isRouteFocused={active}
        recoveryRequested={active && recoveryRequested}
      />
    </ProjectViewFocus>
  );
});

const styles = StyleSheet.create({
  deck: { flex: 1, minWidth: 0, minHeight: 0 },
  row: { flexDirection: "row" },
  divider: { position: "absolute", zIndex: 20 },
  entry: { position: "absolute", minWidth: 0, minHeight: 0, overflow: "hidden" },
});
