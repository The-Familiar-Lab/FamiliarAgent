import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { ActiveWorkspaceSelection } from "./last-workspace-selection";
import {
  closeProjectView,
  EMPTY_PROJECT_VIEWS,
  layoutProjectViews,
  MAX_PROJECT_VIEWS,
  MAX_VISIBLE_PROJECT_VIEWS,
  reorderProjectViews,
  showProjectView,
  type ProjectViews,
} from "@/screens/workspace/project-views";

const schema = z
  .object({
    state: z
      .object({
        views: z
          .array(z.object({ serverId: z.string().min(1), workspaceId: z.string().min(1) }).strict())
          .max(MAX_PROJECT_VIEWS),
        shown: z.array(z.string()).max(MAX_VISIBLE_PROJECT_VIEWS),
        direction: z.enum(["horizontal", "vertical"]).nullable(),
      })
      .strict(),
  })
  .strict();
interface Store {
  state: ProjectViews;
  show: (selection: ActiveWorkspaceSelection, beside?: boolean) => void;
  close: (selection: ActiveWorkspaceSelection) => void;
  layout: (direction: ProjectViews["direction"], active: ActiveWorkspaceSelection) => void;
  reorder: (keys: string[]) => void;
}
export const useProjectViewStore = create<Store>()(
  persist(
    (set) => ({
      state: EMPTY_PROJECT_VIEWS,
      show: (selection, beside) =>
        set((current) => ({ state: showProjectView(current.state, selection, beside) })),
      close: (selection) =>
        set((current) => ({ state: closeProjectView(current.state, selection) })),
      layout: (direction, active) =>
        set((current) => ({ state: layoutProjectViews(current.state, direction, active) })),
      reorder: (keys) => set((current) => ({ state: reorderProjectViews(current.state, keys) })),
    }),
    {
      name: "familiar:project-views",
      storage: createValidatedPersistStorage(AsyncStorage, schema),
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
