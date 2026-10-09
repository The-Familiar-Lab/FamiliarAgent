import { afterEach, expect, it, vi } from "vitest";
import { readWithDeadline, UI_READ_TIMEOUT_MS } from "./read-deadline.js";
afterEach(() => vi.useRealTimers());
it("bounds a read and discards a late answer without starting a retry", async () => {
  vi.useFakeTimers();
  let resolve!: (value: string) => void;
  const operation = readWithDeadline(
    new Promise<string>((done) => {
      resolve = done;
    }),
    "Mac status",
  );
  const rejected = expect(operation).rejects.toThrow(
    "Mac status timed out. Retry the check or choose another server.",
  );
  await vi.advanceTimersByTimeAsync(UI_READ_TIMEOUT_MS);
  await rejected;
  resolve("Late answer");
  expect(vi.getTimerCount()).toBe(0);
});
it("cleans the deadline when a read succeeds or fails immediately", async () => {
  vi.useFakeTimers();
  await expect(readWithDeadline(Promise.resolve("Ready"), "Status")).resolves.toBe("Ready");
  await expect(readWithDeadline(Promise.reject(new Error("Offline")), "Status")).rejects.toThrow(
    "Offline",
  );
  expect(vi.getTimerCount()).toBe(0);
});
