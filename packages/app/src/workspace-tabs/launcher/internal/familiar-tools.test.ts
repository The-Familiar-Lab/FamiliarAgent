import { expect, it, vi } from "vitest";
import { readFamiliarTools } from "./familiar-tools";

it("reads the complete host catalog including uninstalled, desktop, reference and custom tools", async () => {
  const entries = ["goose", "openrig", "orca", "custom"].map((id) => ({
    id,
    name: id,
    installed: false,
    modes: [],
    description: "Original tool",
  }));
  const invoke = vi.fn().mockResolvedValue(entries);
  expect(await readFamiliarTools({ invoke })).toEqual(
    entries.map(({ id, name }) => ({ id, name })),
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith("tools.list", {});
});

it("uses shared bounded guidance and rejects malformed catalog data instead of silently dropping tools", async () => {
  const guide = {
    summary: "Native harness",
    whenToUse: ["Keep native sessions"],
    execution: "Original executable",
    continuation: "Selected results only",
  };
  const invoke = vi.fn().mockResolvedValue([{ id: "new", name: "New tool", guide }]);
  expect((await readFamiliarTools({ invoke }))[0]?.guide).toEqual(guide);
  invoke.mockResolvedValue([
    { id: "new", name: "New tool", guide: { ...guide, whenToUse: "invalid" } },
  ]);
  await expect(readFamiliarTools({ invoke })).rejects.toThrow();
});

it("preserves the actual connection error for a visible retry instead of reporting an empty catalog", async () => {
  const invoke = vi.fn().mockRejectedValue(new Error("Host is offline"));
  await expect(readFamiliarTools({ invoke })).rejects.toThrow("Host is offline");
  expect(invoke).toHaveBeenCalledOnce();
});
