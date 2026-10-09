import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { ToolRunStore } from "./store.js";
import { ToolActions } from "./service.js";
import { executeCommand, requestHttp } from "./transport.js";
import type { ToolActionAdapter } from "./contracts.js";

const directories: string[] = [];
const services: ToolActions[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(adapter: ToolActionAdapter) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-actions-"));
  directories.push(directory);
  const store = new ToolRunStore(directory, "server-a");
  const service = new ToolActions(store, [adapter], async (command) => command);
  services.push(service);
  return {
    directory,
    store,
    service,
    input: {
      operationId: "operation-a",
      sessionId: "session-a",
      toolId: adapter.id,
      action: adapter.actions[0]?.id ?? "run",
      cwd: directory,
      parameters: {},
      input: "",
    },
  };
}
describe("durable native tool actions", () => {
  it("executes a concurrent retry only once and rejects operation ID reuse", async () => {
    let calls = 0;
    const f = await fixture({
      id: "example",
      actions: [{ id: "run", label: "Run", description: "Test" }],
      async execute() {
        calls++;
        return { state: "completed", text: "native output" };
      },
    });
    await Promise.all([f.service.start(f.input), f.service.start(f.input)]);
    expect((await f.service.wait(f.input.operationId)).result?.text).toBe("native output");
    expect(calls).toBe(1);
    await expect(f.service.start({ ...f.input, input: "different" })).rejects.toThrow(
      "Operation ID",
    );
    expect(f.store.list("session-a", 0, 30).total).toBe(1);
    expect(f.store.list("different", 0, 30).total).toBe(0);
  });
  it("keeps interrupted writes unknown and prevents automatic concurrent retries", async () => {
    const started = Promise.withResolvers<void>();
    const f = await fixture({
      id: "example",
      actions: [{ id: "run", label: "Run", description: "Test" }],
      execute: async (_input, context) => {
        const running = context.exec({
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
        });
        started.resolve();
        await running;
        return { state: "completed", text: "unexpected" };
      },
    });
    await f.service.start(f.input);
    await started.promise;
    await expect(f.service.start({ ...f.input, operationId: "operation-b" })).rejects.toThrow(
      "unresolved",
    );
    f.service.cancel(f.input.operationId);
    expect(() =>
      f.service.resolve({ id: f.input.operationId, originalChecked: true, note: "Still stopping" }),
    ).toThrow("stop before");
    expect((await f.service.wait(f.input.operationId)).state).toBe("unknown");
    await f.service.close();
    services.splice(services.indexOf(f.service), 1);
    const reopened = new ToolRunStore(f.directory, "server-a");
    expect(reopened.read(f.input.operationId).state).toBe("unknown");
    reopened.close();
  });
  it("marks stale running entries unknown on restart without invoking the adapter", async () => {
    const f = await fixture({
      id: "example",
      actions: [],
      execute: async () => {
        throw new Error("must not execute");
      },
    });
    const { operationId, ...request } = f.input;
    f.store.create(operationId, request, true);
    await f.service.close();
    services.splice(services.indexOf(f.service), 1);
    const reopened = new ToolRunStore(f.directory, "server-a");
    expect(reopened.read(operationId).state).toBe("unknown");
    reopened.close();
  });
  it("does not reserve a native session when its ID is missing", async () => {
    const f = await fixture({
      id: "example",
      actions: [{ id: "send", label: "Send", description: "Test", nativeId: true }],
      execute: async () => {
        throw new Error("must not execute");
      },
    });
    await expect(f.service.start(f.input)).rejects.toThrow("original session");
    expect(f.store.list("session-a", 0, 30).total).toBe(0);
  });
  it("releases a failed preparation scope without treating it as an unknown delivery", async () => {
    const f = await fixture({
      id: "example",
      actions: [{ id: "run", label: "Run", description: "Test" }],
      execute: async () => {
        throw new Error("Native SDK prerequisite is missing");
      },
    });
    await f.service.start(f.input);
    expect((await f.service.wait(f.input.operationId)).state).toBe("failed");
    await f.service.start({ ...f.input, operationId: "operation-after-setup" });
    expect((await f.service.wait("operation-after-setup")).state).toBe("failed");
  });
  it("does not report ACK as completed and rejects undeclared settings", async () => {
    const f = await fixture({
      id: "example",
      actions: [{ id: "send", label: "Send", description: "Test" }],
      execute: async () => ({ state: "submitted", text: "queued", nativeId: "native-job" }),
    });
    await expect(f.service.start({ ...f.input, parameters: { token: "secret" } })).rejects.toThrow(
      "Unknown action setting",
    );
    await f.service.start(f.input);
    expect((await f.service.wait(f.input.operationId)).state).toBe("submitted");
  });
  it("releases only an explicitly checked unknown scope without fabricating an outcome", async () => {
    const f = await fixture({
      id: "example",
      actions: [{ id: "run", label: "Run", description: "Test" }],
      execute: async (_request, context) => {
        await context.exec({
          command: process.execPath,
          args: ["-e", "process.stdout.write('native ACK')"],
        });
        throw new Error("Lost the final receipt");
      },
    });
    await f.service.start(f.input);
    expect((await f.service.wait(f.input.operationId)).state).toBe("unknown");
    expect(() =>
      f.service.resolve({
        id: f.input.operationId,
        originalChecked: false as true,
        note: "not checked",
      }),
    ).toThrow();
    const released = f.service.resolve({
      id: f.input.operationId,
      originalChecked: true,
      note: "Original process stopped; no active task remains",
    });
    expect(released.state).toBe("unknown");
    expect(released.result).toBeNull();
    expect(released.error).toContain("Original process stopped");
    expect(
      f.service.resolve({ id: f.input.operationId, originalChecked: true, note: "repeated click" }),
    ).toEqual(released);
    await f.service.start({ ...f.input, operationId: "operation-after-check" });
    expect((await f.service.wait("operation-after-check")).state).toBe("unknown");
  });
});
describe("bounded native transports", () => {
  it("passes input without shell interpolation and retains nonzero exit status", async () => {
    const input = "$(touch forbidden) `exit 0` 한글";
    const result = await executeCommand(
      {
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout); process.exitCode=7"],
        stdin: input,
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ stdout: input, stderr: "", exitCode: 7 });
  });
  it("terminates oversized output and timed out processes", async () => {
    await expect(
      executeCommand(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(5000))"],
          maxBytes: 10,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("size limit");
    await expect(
      executeCommand(
        { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 20 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("timed out");
  });
  it("sends raw WebDAV strings and bounds HTTP bodies", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/big") return response.end("x".repeat(1000));
      request.pipe(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No address");
      const url = `http://127.0.0.1:${address.port}`;
      expect(
        await requestHttp(
          { url, method: "PUT", body: "plain\ntext" },
          new AbortController().signal,
        ),
      ).toEqual({ status: 200, body: "plain\ntext" });
      await expect(
        requestHttp({ url: `${url}/big`, maxBytes: 10 }, new AbortController().signal),
      ).rejects.toThrow("size limit");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    }
  });
});

async function nativeProcessIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return true;
    // A container's init/subreaper may retain a killed orphan as a zombie.
    // kill(pid, 0) sees its PID, although that process can no longer execute.
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

it.skipIf(process.platform !== "linux")(
  "distinguishes a running process from a terminated child awaiting its parent to reap it",
  async () => {
    const parent = spawn(
      "python3",
      [
        "-c",
        "import os,sys\npid=os.fork()\nif pid==0: os._exit(0)\nprint(pid,flush=True)\ntry: sys.stdin.readline()\nfinally: os.waitpid(pid,0)\n",
      ],
      { stdio: ["pipe", "pipe", "ignore"], timeout: 5000 },
    );
    const closed = once(parent, "close");
    try {
      expect(await nativeProcessIsRunning(parent.pid!)).toBe(true);
      const [output] = await once(parent.stdout, "data");
      const childPid = Number(output.toString());
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      await vi.waitFor(async () => expect(await nativeProcessIsRunning(childPid)).toBe(false));
      expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
      parent.stdin.end();
      await closed;
    }
  },
);

it.skipIf(process.platform === "win32")(
  "kills same-group descendants even when their parent exits before the grace deadline",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-child-cleanup-"));
    directories.push(directory);
    const file = path.join(directory, "child.pid");
    const controller = new AbortController();
    let pid: number | undefined;
    const task = executeCommand(
      {
        command: process.execPath,
        args: [
          "-e",
          `
    const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`)}],{stdio:'ignore'});
    setInterval(()=>{},1000);
  `,
        ],
      },
      controller.signal,
      { timeoutMs: 5000, maxBytes: 10000, killGraceMs: 100 },
    ).catch((error) => error as Error);
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          pid = Number(await readFile(file, "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(pid).toBeDefined();
      expect(await nativeProcessIsRunning(pid!)).toBe(true);
      controller.abort();
      expect(String(await task)).toContain("cancelled");
      for (let attempt = 0; attempt < 50; attempt++) {
        if (!(await nativeProcessIsRunning(pid!))) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Owned native grandchild survived cancellation");
    } finally {
      controller.abort();
      await task;
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
    }
  },
);
