import { describe, expect, it, vi } from "vitest";
import type { PaseoProviderModelsResult } from "@getpaseo/client";
import {
  resolveSetupModel,
  setupModelSelection,
  setupPermissionMode,
  batchSetupInstructions,
} from "./setup.js";
import type { ToolEntry } from "../../shared/tool-catalog.js";
const response = (
  provider: string,
  models: NonNullable<PaseoProviderModelsResult["models"]>,
): PaseoProviderModelsResult => ({
  provider,
  models,
  fetchedAt: "2026-10-08",
  requestId: "test",
});
it("validates source-advertised thinking and modes, without silently picking a replacement", () => {
  const models = [
    {
      id: "a",
      provider: "codex",
      label: "A",
      defaultThinkingOptionId: "medium",
      thinkingOptions: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    },
  ];
  expect(setupModelSelection(models, { model: "a", thinkingOptionId: "high" })).toEqual({
    model: "a",
    thinking: "high",
  });
  expect(() =>
    setupModelSelection(models, { model: "a", thinkingOptionId: "unsupported" }),
  ).toThrow("thinking level is unavailable");
  expect(() => setupModelSelection(models, { model: "missing" })).toThrow("model is unavailable");
  expect(() =>
    setupPermissionMode(
      { provider: "codex", fetchedAt: "now", requestId: "test", modes: [] },
      "all",
    ),
  ).toThrow("permission mode is unavailable");
});
it("instructs delegated setup to inspect installation and connections before installing", () => {
  const instruction = batchSetupInstructions(
    [{ id: "goose", name: "Goose", installed: true }] as ToolEntry[],
    "/setup",
    true,
    "codex",
  );
  expect(instruction).toContain("Do not reinstall or update a working installation");
  expect(instruction).toContain("verify health and the account/connection");
  expect(instruction).toContain("tools.setup.status");
  expect(instruction).toContain("Prepare tools only");
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
