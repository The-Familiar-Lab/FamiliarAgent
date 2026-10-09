import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import { clampNormalizedSizes } from "@/stores/workspace-layout-actions";
import { getWorkspaceSelectionKey } from "./workspace-deck-retention";

export const MAX_PROJECT_VIEWS = 10;
export const MAX_VISIBLE_PROJECT_VIEWS = 4;
export type ProjectDropPosition = "left" | "right" | "top" | "bottom" | "center";
export interface ProjectSplit {
  kind: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: [ProjectLayout, ProjectLayout];
  sizes: [number, number];
}
export type ProjectLayout = { kind: "leaf"; key: string } | ProjectSplit;
export interface ProjectViews {
  views: ActiveWorkspaceSelection[];
  layout: ProjectLayout | null;
  focusedKey: string | null;
}
export interface LegacyProjectViews {
  views: ActiveWorkspaceSelection[];
  shown: string[];
  direction: "horizontal" | "vertical" | null;
}
export const EMPTY_PROJECT_VIEWS: ProjectViews = { views: [], layout: null, focusedKey: null };
export function projectLayoutKeys(layout: ProjectLayout | null): string[] {
  if (!layout) return [];
  return layout.kind === "leaf" ? [layout.key] : layout.children.flatMap(projectLayoutKeys);
}
function replaceLeaf(
  layout: ProjectLayout,
  key: string,
  replacement: ProjectLayout,
): ProjectLayout {
  if (layout.kind === "leaf") return layout.key === key ? replacement : layout;
  const children = layout.children.map((child) =>
    replaceLeaf(child, key, replacement),
  ) as ProjectSplit["children"];
  return children.every((child, index) => child === layout.children[index])
    ? layout
    : { ...layout, children };
}
function removeLeaf(layout: ProjectLayout | null, key: string): ProjectLayout | null {
  if (!layout) return null;
  if (layout.kind === "leaf") return layout.key === key ? null : layout;
  const left = removeLeaf(layout.children[0], key);
  const right = removeLeaf(layout.children[1], key);
  if (!left) return right;
  if (!right) return left;
  if (left === layout.children[0] && right === layout.children[1]) return layout;
  return { ...layout, children: [left, right] };
}
function retainViews(
  state: ProjectViews,
  selection: ActiveWorkspaceSelection,
  layout: ProjectLayout,
): ActiveWorkspaceSelection[] {
  const key = getWorkspaceSelectionKey(selection);
  if (state.views.some((item) => getWorkspaceSelectionKey(item) === key)) return state.views;
  const views = [...state.views, selection];
  if (views.length <= MAX_PROJECT_VIEWS) return views;
  const visible = new Set(projectLayoutKeys(layout));
  const discard = views.findIndex((item) => !visible.has(getWorkspaceSelectionKey(item)));
  return views.filter((_item, index) => index !== discard);
}
/** Ordinary navigation focuses an existing pane or replaces only the focused pane. */
export function showProjectView(
  state: ProjectViews,
  selection: ActiveWorkspaceSelection,
): ProjectViews {
  const key = getWorkspaceSelectionKey(selection);
  const keys = projectLayoutKeys(state.layout);
  if (keys.includes(key)) return state.focusedKey === key ? state : { ...state, focusedKey: key };
  const leaf: ProjectLayout = { kind: "leaf", key };
  const focused = state.focusedKey && keys.includes(state.focusedKey) ? state.focusedKey : keys[0];
  const layout = state.layout && focused ? replaceLeaf(state.layout, focused, leaf) : leaf;
  return { views: retainViews(state, selection, layout), layout, focusedKey: key };
}
export function closeProjectView(
  state: ProjectViews,
  selection: ActiveWorkspaceSelection,
): ProjectViews {
  const key = getWorkspaceSelectionKey(selection);
  const views = state.views.filter((item) => getWorkspaceSelectionKey(item) !== key);
  if (views.length === state.views.length) return state;
  const layout = removeLeaf(state.layout, key);
  const keys = projectLayoutKeys(layout);
  return {
    views,
    layout,
    focusedKey: keys.includes(state.focusedKey ?? "") ? state.focusedKey : (keys[0] ?? null),
  };
}
/** A source already in the tree moves; it is never duplicated or silently evicted at the limit. */
export function dockProjectView(
  state: ProjectViews,
  selection: ActiveWorkspaceSelection,
  targetKey: string,
  position: ProjectDropPosition,
  splitId: string,
): ProjectViews {
  const key = getWorkspaceSelectionKey(selection);
  const keys = projectLayoutKeys(state.layout);
  if (!state.layout || key === targetKey || !keys.includes(targetKey)) return state;
  if (position !== "center" && !keys.includes(key) && keys.length >= MAX_VISIBLE_PROJECT_VIEWS)
    return state;
  const remaining = removeLeaf(state.layout, key)!;
  const source: ProjectLayout = { kind: "leaf", key };
  const target: ProjectLayout = { kind: "leaf", key: targetKey };
  let replacement: ProjectLayout = source;
  if (position !== "center") {
    if (!splitId || hasSplit(remaining, splitId)) return state;
    const before = position === "left" || position === "top";
    replacement = {
      kind: "split",
      id: splitId,
      direction: position === "left" || position === "right" ? "horizontal" : "vertical",
      children: before ? [source, target] : [target, source],
      sizes: [0.5, 0.5],
    };
  }
  const layout = replaceLeaf(remaining, targetKey, replacement);
  return { views: retainViews(state, selection, layout), layout, focusedKey: key };
}
function hasSplit(layout: ProjectLayout, id: string): boolean {
  return (
    layout.kind === "split" &&
    (layout.id === id || layout.children.some((child) => hasSplit(child, id)))
  );
}
export function resizeProjectViews(
  state: ProjectViews,
  splitId: string,
  sizes: number[],
): ProjectViews {
  if (
    !state.layout ||
    sizes.length !== 2 ||
    sizes.some((size) => !Number.isFinite(size) || size <= 0)
  )
    return state;
  const normalized = clampNormalizedSizes(sizes) as [number, number];
  const resize = (node: ProjectLayout): ProjectLayout => {
    if (node.kind === "leaf") return node;
    if (node.id === splitId)
      return node.sizes.every((size, index) => size === normalized[index])
        ? node
        : { ...node, sizes: normalized };
    const children = node.children.map(resize) as ProjectSplit["children"];
    return children.every((child, index) => child === node.children[index])
      ? node
      : { ...node, children };
  };
  const layout = resize(state.layout);
  return layout === state.layout ? state : { ...state, layout };
}
export function visibleProjectViews(
  state: ProjectViews,
  active: ActiveWorkspaceSelection | null,
  compact = false,
): ActiveWorkspaceSelection[] {
  if (!active) return [];
  if (compact) return [active];
  const current = showProjectView(state, active);
  const byKey = new Map(current.views.map((item) => [getWorkspaceSelectionKey(item), item]));
  return projectLayoutKeys(current.layout).map((key) => byKey.get(key)!);
}
export function reorderProjectViews(state: ProjectViews, keys: string[]): ProjectViews {
  const byKey = new Map(state.views.map((item) => [getWorkspaceSelectionKey(item), item]));
  if (
    keys.length !== byKey.size ||
    new Set(keys).size !== byKey.size ||
    keys.some((key) => !byKey.has(key))
  )
    return state;
  return { ...state, views: keys.map((key) => byKey.get(key)!) };
}
/** One-time storage conversion; old flat equal-width panes keep their displayed order. */
export function migrateProjectViews(state: ProjectViews | LegacyProjectViews): ProjectViews {
  if ("layout" in state) return state;
  const views = [
    ...new Map(state.views.map((item) => [getWorkspaceSelectionKey(item), item])).values(),
  ];
  const keys = views.map(getWorkspaceSelectionKey).filter((key) => state.shown.includes(key));
  if (!keys.length && views[0]) keys.push(getWorkspaceSelectionKey(views[0]));
  const focusedKey =
    [...state.shown].toReversed().find((key) => keys.includes(key)) ?? keys[0] ?? null;
  const single = focusedKey ? [focusedKey] : [];
  const selected = state.direction ? keys.slice(0, MAX_VISIBLE_PROJECT_VIEWS) : single;
  const build = (remaining: string[], index: number): ProjectLayout =>
    remaining.length === 1
      ? { kind: "leaf", key: remaining[0]! }
      : {
          kind: "split",
          id: `migrated-project-split-${index}`,
          direction: state.direction ?? "horizontal",
          children: [{ kind: "leaf", key: remaining[0]! }, build(remaining.slice(1), index + 1)],
          sizes: [1 / remaining.length, (remaining.length - 1) / remaining.length],
        };
  return { views, layout: selected.length ? build(selected, 0) : null, focusedKey };
}
