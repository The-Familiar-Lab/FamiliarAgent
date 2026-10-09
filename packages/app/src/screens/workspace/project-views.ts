import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import { getWorkspaceSelectionKey } from "./workspace-deck-retention";

export const MAX_PROJECT_VIEWS = 10;
export const MAX_VISIBLE_PROJECT_VIEWS = 4;
export interface ProjectViews {
  views: ActiveWorkspaceSelection[];
  shown: string[];
  direction: "horizontal" | "vertical" | null;
}
export const EMPTY_PROJECT_VIEWS: ProjectViews = { views: [], shown: [], direction: null };

export function showProjectView(
  state: ProjectViews,
  selection: ActiveWorkspaceSelection,
  beside = false,
): ProjectViews {
  const key = getWorkspaceSelectionKey(selection);
  let views = state.views.some((item) => getWorkspaceSelectionKey(item) === key)
    ? state.views
    : [...state.views, selection];
  const direction = beside ? (state.direction ?? "horizontal") : state.direction;
  const shown = direction
    ? [...state.shown.filter((id) => id !== key), key].slice(-MAX_VISIBLE_PROJECT_VIEWS)
    : [key];
  if (views.length > MAX_PROJECT_VIEWS) {
    const discard = views.find((item) => !shown.includes(getWorkspaceSelectionKey(item)));
    views = views.filter((item) => item !== discard);
  }
  if (
    views === state.views &&
    direction === state.direction &&
    shown.join("\0") === state.shown.join("\0")
  )
    return state;
  return { views, shown, direction };
}

export function closeProjectView(
  state: ProjectViews,
  selection: ActiveWorkspaceSelection,
): ProjectViews {
  const key = getWorkspaceSelectionKey(selection);
  return {
    ...state,
    views: state.views.filter((item) => getWorkspaceSelectionKey(item) !== key),
    shown: state.shown.filter((id) => id !== key),
  };
}

export function layoutProjectViews(
  state: ProjectViews,
  direction: ProjectViews["direction"],
  active: ActiveWorkspaceSelection,
): ProjectViews {
  const next = showProjectView(state, active);
  const key = getWorkspaceSelectionKey(active);
  const shown = direction
    ? [...new Set([key, ...next.shown, ...next.views.map(getWorkspaceSelectionKey)])].slice(
        0,
        MAX_VISIBLE_PROJECT_VIEWS,
      )
    : [key];
  return { ...next, direction, shown };
}

export function visibleProjectViews(
  state: ProjectViews,
  active: ActiveWorkspaceSelection | null,
  compact = false,
): ActiveWorkspaceSelection[] {
  if (!active) return [];
  const current = showProjectView(state, active);
  if (!current.direction || compact) return [active];
  return current.views.filter((item) => current.shown.includes(getWorkspaceSelectionKey(item)));
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
