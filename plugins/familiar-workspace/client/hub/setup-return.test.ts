// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { consumeSetupReturn, readSetupReturn, saveSetupReturn } from "./setup-return.js";
beforeEach(() => localStorage.clear());
const selection = {
  projectId: "project",
  sessionId: "A",
  target: "linux",
  toolId: "aider",
  cwd: "/project",
  title: "A",
  tab: "Tools" as const,
};
it("stores coordinates only and consumes only the exact pending setup navigation", () => {
  saveSetupReturn("mac", selection);
  const first = readSetupReturn("mac")!;
  expect(readSetupReturn("other-catalog")).toBeNull();
  expect(first).toEqual({ ...selection, id: expect.any(String) });
  saveSetupReturn("mac", { ...selection, toolId: "goose" });
  consumeSetupReturn("mac", first.id);
  const newer = readSetupReturn("mac")!;
  expect(newer.toolId).toBe("goose");
  consumeSetupReturn("mac", newer.id);
  expect(readSetupReturn("mac")).toBeNull();
});
it("rejects unsupported routes and session references without a project", () => {
  expect(() => saveSetupReturn("mac", { ...selection, tab: "Injected" as never })).toThrow();
  expect(() => saveSetupReturn("mac", { ...selection, projectId: null })).toThrow();
  expect(localStorage.length).toBe(0);
});
