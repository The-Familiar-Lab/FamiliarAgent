import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function check(agents: unknown) {
  const script = readFileSync(
    new URL("../../../assets/familiar/apply-runtime.sh", import.meta.url),
    "utf8",
  );
  const program = script.match(/<<'NODE'[^\n]*\n([\s\S]*?)\nNODE/u)?.[1];
  if (!program) throw new Error("Runtime updater policy is missing");
  const directory = mkdtempSync(path.join(tmpdir(), "familiar-update-"));
  temporary.push(directory);
  const file = path.join(directory, "agents.json");
  writeFileSync(file, JSON.stringify(agents));
  try {
    execFileSync(process.execPath, ["-", file], {
      input: program,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
}
it("updates idle retained conversations while deferring active or unknown runtime states", () => {
  expect(check([{ status: "idle" }, { status: "closed" }, { status: "error" }])).toBe(0);
  expect(check([])).toBe(0);
  expect(check([{ status: "running" }])).toBe(10);
  expect(check([{ status: "initializing" }])).toBe(10);
  expect(check([{ status: "future-state" }])).toBe(10);
  expect(check({ malformed: true })).toBe(5);
});
