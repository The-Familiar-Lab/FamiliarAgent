import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@react-native-async-storage/async-storage", () => {
  const data = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => data.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        data.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        data.delete(key);
      }),
    },
  };
});
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ProjectViewsPersistedStateSchema, useProjectViewStore } from "./project-view-store";
import { EMPTY_PROJECT_VIEWS, projectLayoutKeys } from "@/screens/workspace/project-views";
const a = { serverId: "mac", workspaceId: "one" };
const b = { serverId: "linux", workspaceId: "one" };
const storageKey = "familiar:project-views";
beforeEach(async () => {
  await useProjectViewStore.persist.clearStorage();
  useProjectViewStore.setState({ state: EMPTY_PROJECT_VIEWS });
});
it("hydrates old persisted layout and saves subsequent dock sizes in the new tree", async () => {
  await AsyncStorage.setItem(
    storageKey,
    JSON.stringify({
      state: { state: { views: [a, b], shown: ["mac:one", "linux:one"], direction: "vertical" } },
      version: 0,
    }),
  );
  await useProjectViewStore.persist.rehydrate();
  expect(projectLayoutKeys(useProjectViewStore.getState().state.layout)).toEqual([
    "mac:one",
    "linux:one",
  ]);
  useProjectViewStore.getState().resize("migrated-project-split-0", [1, 3]);
  await vi.waitFor(async () =>
    expect(JSON.parse((await AsyncStorage.getItem(storageKey))!).state.state.layout.sizes).toEqual([
      0.25, 0.75,
    ]),
  );
  useProjectViewStore.setState({ state: EMPTY_PROJECT_VIEWS });
  await AsyncStorage.setItem(
    storageKey,
    JSON.stringify({
      state: {
        state: {
          views: [a, b],
          layout: {
            kind: "split",
            id: "saved",
            direction: "horizontal",
            children: [
              { kind: "leaf", key: "mac:one" },
              { kind: "leaf", key: "linux:one" },
            ],
            sizes: [1, 3],
          },
          focusedKey: "linux:one",
        },
      },
      version: 0,
    }),
  );
  await useProjectViewStore.persist.rehydrate();
  expect(useProjectViewStore.getState().state.layout).toMatchObject({
    id: "saved",
    sizes: [0.25, 0.75],
  });
});
it("store actions dock, focus and close using server-qualified leaf keys", () => {
  const store = useProjectViewStore.getState();
  store.show(a);
  store.dock(b, "mac:one", "right");
  const before = useProjectViewStore.getState().state.layout;
  store.show(a);
  expect(useProjectViewStore.getState().state.layout).toBe(before);
  expect(useProjectViewStore.getState().state.focusedKey).toBe("mac:one");
  store.close(a);
  expect(useProjectViewStore.getState().state.layout).toEqual({ kind: "leaf", key: "linux:one" });
});
it("rejects unknown or duplicate pane identities and a corrupt focused key", () => {
  const base = { views: [a, b], focusedKey: "mac:one", layout: { kind: "leaf", key: "mac:one" } };
  expect(ProjectViewsPersistedStateSchema.safeParse({ state: base }).success).toBe(true);
  expect(
    ProjectViewsPersistedStateSchema.safeParse({ state: { ...base, focusedKey: "absent" } })
      .success,
  ).toBe(false);
  expect(
    ProjectViewsPersistedStateSchema.safeParse({
      state: { ...base, layout: { kind: "leaf", key: "absent" } },
    }).success,
  ).toBe(false);
  expect(
    ProjectViewsPersistedStateSchema.safeParse({
      state: {
        ...base,
        layout: {
          kind: "split",
          id: "duplicate",
          direction: "horizontal",
          children: [base.layout, base.layout],
          sizes: [0.5, 0.5],
        },
      },
    }).success,
  ).toBe(false);
});
