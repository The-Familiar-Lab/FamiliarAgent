import { afterEach, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { TerminalExitCache, describeTerminalExit } from "./terminal-exit-cache.js";
import { createTerminalManager } from "./terminal-manager.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";

afterEach(() => vi.useRealTimers());
it("bounds recent exit diagnostics and expires them without holding PTYs or timers", () => {
  vi.useFakeTimers();
  const cache = new TerminalExitCache();
  const info = {
    exitCode: 127,
    signal: null,
    lastOutputLines: ["command not found: missing-tool"],
  };
  for (let id = 0; id < 40; id++) cache.set(String(id), info);
  expect(cache.get("0")).toBeUndefined();
  expect(describeTerminalExit(cache.get("39")!)).toContain("exit code 127");
  expect(describeTerminalExit(info)).toContain("command not found: missing-tool");
  vi.advanceTimersByTime(5 * 60 * 1000 + 1);
  expect(cache.get("39")).toBeUndefined();
});

for (const [mode, create] of [
  ["in-process", createTerminalManager],
  ["worker", createWorkerTerminalManager],
] as const) {
  it(`${mode} retains final output after a fast native process is removed`, async () => {
    const manager = create();
    try {
      const terminal = await manager.createTerminal({
        cwd: realpathSync(tmpdir()),
        workspaceId: "exit-diagnostics-proof",
        command: process.execPath,
        args: [
          "-e",
          "process.stderr.write('SETUP_REQUIRED: sign in with the original tool\\n'); process.exitCode = 7",
        ],
      });
      await expect
        .poll(() => manager.getTerminalExitInfo?.(terminal.id), { timeout: 8000 })
        .toMatchObject({ exitCode: 7 });
      expect(manager.getTerminal(terminal.id)).toBeUndefined();
      expect(manager.getTerminalExitInfo?.(terminal.id)?.lastOutputLines.join("\n")).toContain(
        "SETUP_REQUIRED",
      );
      expect(await manager.getTerminals(realpathSync(tmpdir()))).toEqual([]);
      const replacement = await manager.createTerminal({
        id: terminal.id,
        cwd: realpathSync(tmpdir()),
        workspaceId: "exit-diagnostics-proof",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      });
      expect(manager.getTerminal(replacement.id)).toBe(replacement);
      expect(manager.getTerminalExitInfo?.(replacement.id)).toBeUndefined();
      await manager.killTerminalAndWait(replacement.id);
    } finally {
      manager.killAll();
    }
  }, 15000);
}
