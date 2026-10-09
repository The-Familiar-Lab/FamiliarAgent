import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { readBounded } from "./native-files.js";
function blockedChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
    kill: vi.fn(() => false),
  });
}
afterEach(() => vi.useRealTimers());
it("returns on deadline but retains capacity until a blocked OS child actually closes", async () => {
  vi.useFakeTimers();
  const first = blockedChild();
  const second = blockedChild();
  spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const reads = [readBounded("/first"), readBounded("/second")];
  const settled = Promise.allSettled(reads);
  await vi.advanceTimersByTimeAsync(3000);
  expect((await settled).map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
  expect(first.kill).toHaveBeenCalledWith("SIGKILL");
  expect(first.stdout.destroyed).toBe(true);
  expect(first.stdin.destroyed).toBe(true);
  expect(first.unref).toHaveBeenCalledOnce();
  await expect(readBounded("/third")).rejects.toThrow("still busy");
  expect(spawn).toHaveBeenCalledTimes(2);
  first.emit("close", 0);
  const third = blockedChild();
  spawn.mockReturnValueOnce(third);
  const recovered = readBounded("/third");
  third.stdout.write(JSON.stringify({ base64: Buffer.from("recovered").toString("base64") }));
  third.emit("close", 0);
  await expect(recovered).resolves.toBe("recovered");
  second.emit("close", 0);
});
