import { getWorkspaceSelectionKey } from "@/screens/workspace/workspace-deck-retention";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { ActiveWorkspaceSelection } from "./last-workspace-selection";
import { clampNormalizedSizes } from "./workspace-layout-actions";
import {
  closeProjectView,
  EMPTY_PROJECT_VIEWS,
  dockProjectView,
  resizeProjectViews,
  migrateProjectViews,
  projectLayoutKeys,
  type ProjectDropPosition,
  type ProjectLayout,
  MAX_PROJECT_VIEWS,
  MAX_VISIBLE_PROJECT_VIEWS,
  reorderProjectViews,
  showProjectView,
  type ProjectViews,
} from "@/screens/workspace/project-views";

const selectionSchema = z
  .object({ serverId: z.string().min(1), workspaceId: z.string().min(1) })
  .strict();
const leafSchema = z.object({ kind: z.literal("leaf"), key: z.string().min(1) }).strict();
function layoutSchema(depth = 0): z.ZodType<ProjectLayout> {
  if (depth >= MAX_VISIBLE_PROJECT_VIEWS - 1) return leafSchema;
  return z.union([
    leafSchema,
    z
      .object({
        kind: z.literal("split"),
        id: z.string().min(1),
        direction: z.enum(["horizontal", "vertical"]),
        children: z.tuple([layoutSchema(depth + 1), layoutSchema(depth + 1)]),
        sizes: z
          .tuple([z.number().finite().positive(), z.number().finite().positive()])
          .transform((sizes) => clampNormalizedSizes(sizes) as [number, number]),
      })
      .strict(),
  ]);
}
function validLayout(state: ProjectViews): boolean {
  const leaves = projectLayoutKeys(state.layout);
  const views = new Set(state.views.map(getWorkspaceSelectionKey));
  const splits = new Set<string>();
  let validIds = true;
  const inspect = (node: ProjectLayout | null) => {
    if (!node || node.kind === "leaf") return;
    if (splits.has(node.id)) validIds = false;
    splits.add(node.id);
    node.children.forEach(inspect);
  };
  inspect(state.layout);
  return (
    validIds &&
    views.size === state.views.length &&
    leaves.length <= MAX_VISIBLE_PROJECT_VIEWS &&
    new Set(leaves).size === leaves.length &&
    leaves.every((key) => views.has(key)) &&
    (leaves.length ? leaves.includes(state.focusedKey ?? "") : state.focusedKey === null)
  );
}
export const ProjectViewsPersistedStateSchema = z
  .object({
    state: z
      .union([
        z
          .object({
            views: z.array(selectionSchema).max(MAX_PROJECT_VIEWS),
            layout: layoutSchema().nullable(),
            focusedKey: z.string().nullable(),
          })
          .strict()
          .refine(validLayout),
        z
          .object({
            views: z.array(selectionSchema).max(MAX_PROJECT_VIEWS),
            shown: z.array(z.string()).max(MAX_VISIBLE_PROJECT_VIEWS),
            direction: z.enum(["horizontal", "vertical"]).nullable(),
          })
          .strict(),
      ])
      .transform(migrateProjectViews),
  })
  .strict();
interface Store {
  state: ProjectViews;
  show: (selection: ActiveWorkspaceSelection) => void;
  close: (selection: ActiveWorkspaceSelection) => void;
  dock: (
    selection: ActiveWorkspaceSelection,
    targetKey: string,
    position: ProjectDropPosition,
  ) => void;
  resize: (splitId: string, sizes: number[]) => void;
  reorder: (keys: string[]) => void;
}
export const useProjectViewStore = create<Store>()(
  persist(
    (set) => ({
      state: EMPTY_PROJECT_VIEWS,
      show: (selection) => set((current) => ({ state: showProjectView(current.state, selection) })),
      close: (selection) =>
        set((current) => ({ state: closeProjectView(current.state, selection) })),
      dock: (selection, targetKey, position) =>
        set((current) => ({
          state: dockProjectView(
            current.state,
            selection,
            targetKey,
            position,
            `project-split-${globalThis.crypto.randomUUID()}`,
          ),
        })),
      resize: (splitId, sizes) =>
        set((current) => ({ state: resizeProjectViews(current.state, splitId, sizes) })),
      reorder: (keys) => set((current) => ({ state: reorderProjectViews(current.state, keys) })),
    }),
    {
      name: "familiar:project-views",
      storage: createValidatedPersistStorage(AsyncStorage, ProjectViewsPersistedStateSchema),
      partialize: ({ state }) => ({ state }),
    },
  ),
);
export function useProjectViewsHydrated() {
  const [ready, setReady] = useState(useProjectViewStore.persist.hasHydrated());
  useEffect(() => {
    if (useProjectViewStore.persist.hasHydrated()) {
      setReady(true);
      return;
    }
    return useProjectViewStore.persist.onFinishHydration(() => setReady(true));
  }, []);
  return ready;
}
