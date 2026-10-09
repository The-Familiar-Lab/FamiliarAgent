import { describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createBrowserStore, createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from ".";
import { createBrowserRecord } from "./state";

const STORAGE_KEY = "workspace-browser-store";
const PRIVATE_CANARY = "FAKE_PRIVATE_BROWSER_TOKEN";

function memoryStorage(initial?: string): StateStorage & { writes: string[] } {
  let current = initial ?? null;
  const writes: string[] = [];
  return {
    writes,
    getItem: async () => current,
    setItem: async (_name, value) => {
      current = value;
      writes.push(value);
    },
    removeItem: async () => {
      current = null;
    },
  };
}

describe("private browser persistence", () => {
  it("keeps private URL, title, favicon and errors out of every persisted write", async () => {
    const storage = memoryStorage();
    const store = createBrowserStore(storage);
    await store.persist.rehydrate();
    const publicId = store.getState().createBrowser({ initialUrl: "https://example.com/docs" });
    const privateId = store.getState().createBrowser({
      initialUrl: `http://127.0.0.1:3210/?token=${PRIVATE_CANARY}`,
      ephemeral: true,
    });
    store.getState().updateBrowser(privateId, {
      title: PRIVATE_CANARY,
      faviconUrl: `http://127.0.0.1:3210/icon?token=${PRIVATE_CANARY}`,
      lastError: PRIVATE_CANARY,
    });
    store.getState().setBrowserViewport(privateId, { mode: "fixed", width: 700, height: 500 });
    store.getState().updateBrowser(publicId, { title: "Docs" });
    await vi.waitFor(() => expect(storage.writes.length).toBeGreaterThanOrEqual(5));

    for (const value of storage.writes) {
      expect(value).not.toContain(PRIVATE_CANARY);
      expect(value).not.toContain(privateId);
    }
    expect(store.getState().browsersById[privateId]).toMatchObject({
      ephemeral: true,
      title: PRIVATE_CANARY,
      viewport: { mode: "fixed", width: 700, height: 500 },
    });

    const restored = createBrowserStore(storage);
    await restored.persist.rehydrate();
    expect(Object.keys(restored.getState().browsersById)).toEqual([publicId]);
    expect(restored.getState().browsersById[publicId]?.title).toBe("Docs");
  });

  it("drops stale serialized private records while restoring ordinary records", async () => {
    const privateRecord = createBrowserRecord({
      browserId: "private-id",
      initialUrl: `http://localhost:3210/?token=${PRIVATE_CANARY}`,
      ephemeral: true,
      now: 1,
    });
    const normal = createBrowserRecord({
      browserId: "public-id",
      initialUrl: "example.com",
      now: 1,
    });
    const store = createBrowserStore(
      memoryStorage(
        JSON.stringify({
          state: {
            browsersById: { [privateRecord.browserId]: privateRecord, [normal.browserId]: normal },
          },
          version: 0,
        }),
      ),
    );
    await store.persist.rehydrate();
    expect(store.getState().browsersById).toEqual({ [normal.browserId]: normal });
  });

  it("does not discard a live private view when delayed storage hydration completes", async () => {
    let resolveRead!: (value: string) => void;
    const storageRead = new Promise<string>((resolve) => {
      resolveRead = resolve;
    });
    const storage = memoryStorage();
    const store = createBrowserStore({ ...storage, getItem: () => storageRead });
    const privateId = store
      .getState()
      .createBrowser({ initialUrl: "http://localhost:3210", ephemeral: true });
    const normal = createBrowserRecord({ browserId: "saved", initialUrl: "example.com", now: 1 });
    resolveRead(JSON.stringify({ state: { browsersById: { saved: normal } }, version: 0 }));
    await vi.waitFor(() => expect(store.persist.hasHydrated()).toBe(true));
    expect(store.getState().browsersById[privateId]?.ephemeral).toBe(true);
    expect(store.getState().browsersById.saved).toEqual(normal);
  });

  it("supports the workspace entry point without changing its browser handle", () => {
    const created = createWorkspaceBrowser({ initialUrl: "localhost:3210", ephemeral: true });
    try {
      expect(created.url).toBe("http://localhost:3210");
      expect(getBrowserRecord(created.browserId)?.ephemeral).toBe(true);
      expect(useBrowserStore.persist.getOptions().name).toBe(STORAGE_KEY);
    } finally {
      useBrowserStore.getState().removeBrowser(created.browserId);
    }
  });
});
