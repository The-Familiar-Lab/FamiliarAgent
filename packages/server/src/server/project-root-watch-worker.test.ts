import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectRootWatchWorker } from "./project-root-watch-worker.js";

const pools: ProjectRootWatchWorker[] = [];
const roots: string[] = [];
afterEach(async () => {
  pools.splice(0).forEach((pool) => pool.dispose());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("watches real directories through one worker and stops events after unsubscribe", async () => {
  const root = await mkdtemp(join(tmpdir(), "familiar-root-watch-"));
  roots.push(root);
  const pool = new ProjectRootWatchWorker();
  pools.push(pool);
  const events: Array<string | Buffer | null> = [];
  const errors = vi.fn();
  const watch = await pool.watch(
    root,
    { recursive: false },
    (_event, file) => events.push(file),
    errors,
  );
  await mkdir(join(root, ".git"));
  await vi.waitFor(() => expect(events).toContain(".git"));
  watch.close();
  const count = events.length;
  await writeFile(join(root, "after-close"), "no event");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(events).toHaveLength(count);
  expect(errors).not.toHaveBeenCalled();
});

it("keeps the caller event loop responsive during a blocked native setup and refuses immediate retries", async () => {
  let created = 0;
  const pool = new ProjectRootWatchWorker(() => {
    created++;
    return new Worker("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)", {
      eval: true,
    });
  }, 80);
  pools.push(pool);
  let responsive = false;
  setTimeout(() => {
    responsive = true;
  }, 10);
  await expect(pool.watch("/gated", { recursive: false }, vi.fn(), vi.fn())).rejects.toThrow(
    "timed out",
  );
  expect(responsive).toBe(true);
  expect(() => pool.watch("/another", { recursive: false }, vi.fn(), vi.fn())).toThrow(
    "operating system",
  );
  expect(created).toBe(1);
});

class DelayedWorker extends EventEmitter {
  postMessage = vi.fn();
  unref = vi.fn();
  terminate = vi.fn(() => new Promise<number>(() => {}));
}

it("quarantines a native worker until exit, drops late messages, and fails existing subscriptions", async () => {
  const worker = new DelayedWorker();
  const create = vi.fn(() => worker as unknown as Worker);
  const pool = new ProjectRootWatchWorker(create, 20);
  pools.push(pool);
  const events = vi.fn(),
    errors = vi.fn();
  const first = pool.watch("/ready", { recursive: false }, events, errors);
  worker.emit("message", { id: 1, ready: true });
  await first;
  await expect(pool.watch("/gated", { recursive: false }, events, errors)).rejects.toThrow(
    "timed out",
  );
  worker.emit("message", { id: 2, ready: true });
  worker.emit("message", { id: 1, event: "rename", filename: ".git" });
  expect(events).not.toHaveBeenCalled();
  expect(errors).toHaveBeenCalledTimes(1);
  expect(() => pool.watch("/retry", { recursive: false }, events, errors)).toThrow(
    "operating system",
  );
  expect(create).toHaveBeenCalledTimes(1);
});

it("dispose rejects pending setup, clears its deadline and closes the actual worker", async () => {
  const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
  const exited = once(worker, "exit");
  const pool = new ProjectRootWatchWorker(() => worker, 1000);
  const setup = pool.watch("/pending", { recursive: false }, vi.fn(), vi.fn());
  pool.dispose();
  await expect(setup).rejects.toThrow("closed");
  await exited;
  expect(() => pool.watch("/late", { recursive: false }, vi.fn(), vi.fn())).toThrow("closed");
});
