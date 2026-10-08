import { describe, expect, it, vi } from "vitest";
import type { PaseoProviderModelsResult } from "@getpaseo/client";
import { resolveSetupModel } from "./setup.js";
const response = (
  provider: string,
  models: NonNullable<PaseoProviderModelsResult["models"]>,
): PaseoProviderModelsResult => ({
  provider,
  models,
  fetchedAt: "2026-10-08",
  requestId: "test",
});
describe("setup agent provider selection", () => {
  it("falls back from an unavailable provider and excludes unsupported default models", async () => {
    const list = vi.fn(async (provider: string) => {
      if (provider === "claude") throw new Error("Sign in required");
      return response(provider, [
        { id: "blocked", provider, label: "Blocked", isSelectable: false, isDefault: true },
        { id: "available", provider, label: "Available", defaultThinkingOptionId: "high" },
      ]);
    });
    await expect(resolveSetupModel(["claude", "claude", "antigravity"], list)).resolves.toEqual({
      provider: "antigravity",
      model: "available",
      thinking: "high",
    });
    expect(list.mock.calls.map(([provider]) => provider)).toEqual(["claude", "antigravity"]);
  });
  it("prefers a supported default and surfaces explicit account failures when none can run", async () => {
    await expect(
      resolveSetupModel(["opencode"], async (provider) =>
        response(provider, [
          { id: "first", provider, label: "First" },
          { id: "default", provider, label: "Default", isDefault: true },
        ]),
      ),
    ).resolves.toMatchObject({ provider: "opencode", model: "default" });
    await expect(
      resolveSetupModel(["codex"], async (provider) => ({
        ...response(provider, []),
        error: "No active login",
      })),
    ).rejects.toThrow("codex: No active login");
    await expect(resolveSetupModel([], async (provider) => response(provider, []))).rejects.toThrow(
      "Sign in to an available native agent",
    );
  });
});
