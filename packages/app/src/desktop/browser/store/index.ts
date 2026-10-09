import AsyncStorage from "@react-native-async-storage/async-storage";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  applyBrowserPatch,
  BrowserIndexStateSchema,
  type BrowserIndexState,
  type BrowserRecord,
  type BrowserRecordPatch,
  type BrowserViewport,
  type CreateBrowserInput,
  createBrowserRecord,
  normalizeBrowserIndexState,
  normalizeBrowserUrl,
  removeBrowserFromIndex,
  sanitizeBrowsersForPersist,
  trimNonEmpty,
} from "./state";

export {
  createFixedBrowserViewport,
  RESPONSIVE_BROWSER_VIEWPORT,
  type BrowserRecord,
  type BrowserViewport,
} from "./state";

interface BrowserStoreState extends BrowserIndexState {
  createBrowser: (input?: CreateBrowserInput) => string;
  updateBrowser: (browserId: string, patch: BrowserRecordPatch) => void;
  setBrowserViewport: (browserId: string, viewport: BrowserViewport) => void;
  removeBrowser: (browserId: string) => void;
}

function createBrowserId(): string {
  let browserId: string;
  if (typeof globalThis.crypto?.randomUUID === "function") {
    browserId = globalThis.crypto.randomUUID();
  } else {
    const randomSuffix = Math.random().toString(16).slice(2) || "0";
    browserId = `${Date.now()}-${randomSuffix}`;
  }
  return BrowserAutomationBrowserIdSchema.parse(browserId);
}

export function createBrowserStore(storage: StateStorage = AsyncStorage) {
  return create<BrowserStoreState>()(
    persist(
      (set) => ({
        browsersById: {},
        createBrowser: (input) => {
          const browserId = createBrowserId();
          const record = createBrowserRecord({
            browserId,
            initialUrl: input?.initialUrl,
            ephemeral: input?.ephemeral,
            now: Date.now(),
          });

          set((state) => ({
            browsersById: {
              ...state.browsersById,
              [browserId]: record,
            },
          }));

          return browserId;
        },
        updateBrowser: (browserId, patch) => {
          set((state) => applyBrowserPatch(state, browserId, patch));
        },
        setBrowserViewport: (browserId, viewport) => {
          set((state) => applyBrowserPatch(state, browserId, { viewport }));
        },
        removeBrowser: (browserId) => {
          set((state) => removeBrowserFromIndex(state, browserId));
        },
      }),
      {
        name: "workspace-browser-store",
        storage: createValidatedPersistStorage(storage, BrowserIndexStateSchema),
        partialize: (state) => sanitizeBrowsersForPersist(state),
        merge: (persistedState, currentState) => ({
          ...currentState,
          browsersById: {
            ...normalizeBrowserIndexState(persistedState).browsersById,
            ...currentState.browsersById,
          },
        }),
      },
    ),
  );
}

export const useBrowserStore = createBrowserStore();

export function getBrowserRecord(browserId: string): BrowserRecord | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  return useBrowserStore.getState().browsersById[normalizedBrowserId] ?? null;
}

export function createWorkspaceBrowser(input?: CreateBrowserInput): {
  browserId: string;
  url: string;
} {
  const browserId = useBrowserStore.getState().createBrowser(input);
  const record = getBrowserRecord(browserId);
  return {
    browserId,
    url: record?.url ?? normalizeBrowserUrl(input?.initialUrl),
  };
}

export function normalizeWorkspaceBrowserUrl(value: string | null | undefined): string {
  return normalizeBrowserUrl(value);
}
