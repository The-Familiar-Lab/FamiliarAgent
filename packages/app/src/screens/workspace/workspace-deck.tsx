import {
  Fragment,
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
import { showProjectView, visibleProjectViews } from "./project-views";
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
  const signature = visible.map(getWorkspaceSelectionKey).join("\0");
  const [retained, setRetained] = useState<RetainedWorkspaceSelection[]>([]);
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const [split, setSplit] = useState({ signature: "", sizes: [] as number[] });
  const sizes = split.signature === signature ? split.sizes : visible.map(() => 1 / visible.length);
  const direction = state.direction ?? "horizontal";
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
  const order = new Map(
    visible.map((selection, index) => [getWorkspaceSelectionKey(selection), index]),
  );
  const entries = [...next].sort(
    (a, b) =>
      (order.get(getWorkspaceSelectionKey(a.selection)) ?? Infinity) -
      (order.get(getWorkspaceSelectionKey(b.selection)) ?? Infinity),
  );
  const resize = useCallback(
    (_id: string, nextSizes: number[]) => setSplit({ signature, sizes: nextSizes }),
    [signature],
  );
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setLayout(event.nativeEvent.layout),
    [],
  );
  return (
    <View style={styles.deck}>
      {active && hydrated ? <ProjectViewsBar active={active} state={state} /> : null}
      <View
        style={[styles.deck, direction === "horizontal" ? styles.row : styles.column]}
        onLayout={onLayout}
      >
        {entries.map(({ selection }) => {
          const key = getWorkspaceSelectionKey(selection);
          const index = order.get(key);
          return (
            <Fragment key={key}>
              <WorkspaceDeckEntry
                selection={selection}
                active={areWorkspaceSelectionsEqual(selection, active)}
                visible={index !== undefined}
                size={index === undefined ? 1 : sizes[index]!}
                recoveryRequested={recoveryRequested}
                onUnmountInactive={remove}
              />
              {index !== undefined && index < visible.length - 1 ? (
                <ResizeHandle
                  direction={direction}
                  groupId="project-views"
                  index={index}
                  sizes={sizes}
                  containerSize={direction === "horizontal" ? layout.width : layout.height}
                  onPreviewResizeSplit={resize}
                  onResizeSplit={resize}
                />
              ) : null}
            </Fragment>
          );
        })}
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
  size,
  recoveryRequested,
  onUnmountInactive,
}: {
  selection: ActiveWorkspaceSelection;
  active: boolean;
  visible: boolean;
  size: number;
  recoveryRequested: boolean;
  onUnmountInactive: (selection: ActiveWorkspaceSelection) => void;
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
  if (!keep) return null;
  return (
    <RetainedPanel
      active={visible}
      style={[styles.entry, { flex: size }]}
      testID={`workspace-deck-entry-${getWorkspaceSelectionKey(selection)}`}
    >
      <ProjectViewFocus active={active} visible={visible} selection={selection}>
        <WorkspaceScreen
          serverId={selection.serverId}
          workspaceId={selection.workspaceId}
          isRouteFocused={active}
          recoveryRequested={active && recoveryRequested}
        />
      </ProjectViewFocus>
    </RetainedPanel>
  );
}

const styles = StyleSheet.create({
  deck: { flex: 1, minWidth: 0, minHeight: 0 },
  row: { flexDirection: "row" },
  column: { flexDirection: "column" },
  entry: { minWidth: 0, minHeight: 0, overflow: "hidden" },
});
