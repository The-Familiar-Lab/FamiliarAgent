import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectIconDiscovery } from "./project-icon-discovery.js";

function childFixture() {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

afterEach(() => vi.useRealTimers());

describe("isolated automatic project icons", () => {
  it("uses the real Node child and source module to discover an SVG", async () => {
    const directory = await mkdtemp(join(tmpdir(), "familiar-icon-source-"));
    try {
      await mkdir(join(directory, "public"));
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>';
      await writeFile(join(directory, "public", "favicon.svg"), svg);
      await expect(new ProjectIconDiscovery().read(directory)).resolves.toEqual({
        data: Buffer.from(svg).toString("base64"),
        mimeType: "image/svg+xml",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates only in-flight requests and observes subsequent source changes", async () => {
    const launch = vi.fn(() => childFixture());
    const discovery = new ProjectIconDiscovery(launch);
    const first = discovery.read("/project");
    expect(discovery.read("/project")).toBe(first);
    const child = launch.mock.results[0]!.value;
    child.stdout!.emit("data", Buffer.from('{"data":"YQ==","mimeType":"image/png"}'));
    child.emit("close", 0);
    await expect(first).resolves.toEqual({ data: "YQ==", mimeType: "image/png" });
    const changed = discovery.read("/project");
    expect(launch).toHaveBeenCalledTimes(2);
    launch.mock.results[1]!.value.emit("close", 1);
    await expect(changed).resolves.toBeNull();
  });

  it("retains timed-out process slots until exit and bounds queued work", async () => {
    vi.useFakeTimers();
    const launch = vi.fn(() => childFixture());
    const discovery = new ProjectIconDiscovery(launch, 100);
    const reads = Array.from({ length: 100 }, (_, i) => discovery.read(`/project/${i}`));
    expect(launch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all(reads)).toEqual(Array(100).fill(null));
    expect(launch.mock.results[0]!.value.kill).toHaveBeenCalledWith("SIGKILL");
    expect(launch.mock.results[0]!.value.stdout!.destroyed).toBe(true);
    expect(launch.mock.results[0]!.value.unref).toHaveBeenCalledOnce();
    const waiting = discovery.read("/another-project");
    expect(launch).toHaveBeenCalledTimes(2);
    launch.mock.results[0]!.value.emit("close", null);
    expect(launch).toHaveBeenCalledTimes(3);
    launch.mock.results[2]!.value.stdout!.emit("data", Buffer.from("null"));
    launch.mock.results[2]!.value.emit("close", 0);
    launch.mock.results[1]!.value.emit("close", null);
    await expect(waiting).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["oversized", "malformed", "spawn failure", "process error"])(
    "falls back to the default icon for %s without leaking its deadline",
    async (failure) => {
      vi.useFakeTimers();
      const child = childFixture();
      const discovery = new ProjectIconDiscovery(() => {
        if (failure === "spawn failure") throw new Error("unavailable");
        return child;
      });
      const result = discovery.read("/project");
      if (failure === "oversized") child.stdout!.emit("data", Buffer.alloc(64 * 1024 + 1));
      if (failure === "malformed") child.stdout!.emit("data", Buffer.from("not json"));
      if (failure === "process error") child.emit("error", new Error("unavailable"));
      child.emit("close", 0);
      await expect(result).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps parent filesystem reads responsive while native child I/O blocks and kills the child",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "familiar-icon-blocked-"));
      const fifo = join(directory, "blocked-io");
      const file = join(directory, "responsive");
      let child: ChildProcess | undefined;
      let closed: Promise<unknown> | undefined;
      try {
        execFileSync("mkfifo", [fifo]);
        await writeFile(file, "parent filesystem remains available");
        const discovery = new ProjectIconDiscovery(() => {
          child = spawn(
            process.execPath,
            [
              "-e",
              [
                "const fs = require('node:fs');",
                "for(let i=0;i<4;i++) fs.open(process.argv[1], 'r', () => {});",
                "setTimeout(() => process.stdout.write('native I/O queued'), 50);",
              ].join(""),
              fifo,
            ],
            {
              env: { ...process.env, UV_THREADPOOL_SIZE: "4", ELECTRON_RUN_AS_NODE: "1" },
              stdio: ["ignore", "pipe", "ignore"],
            },
          );
          closed = once(child, "close");
          return child;
        }, 1_000);
        const result = discovery.read(directory);
        await once(child!.stdout!, "data");
        await expect(readFile(file, "utf8")).resolves.toBe("parent filesystem remains available");
        await expect(result).resolves.toBeNull();
        await expect(closed).resolves.toEqual([null, "SIGKILL"]);
        expect(() => process.kill(child!.pid!, 0)).toThrow();
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
