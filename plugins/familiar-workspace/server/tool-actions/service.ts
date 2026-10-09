import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  startToolAction,
  toolActionDefinition,
  toolActionResult,
  resolveToolRun,
} from "../../shared/tool-actions.js";
import type { z } from "zod";
import type { ToolActionAdapter, ToolActionDefinition, ToolActionRequest } from "./contracts.js";
import { ToolRunStore } from "./store.js";
import { executeCommand, requestHttp } from "./transport.js";

function validateActionInput(request: ToolActionRequest, definition: ToolActionDefinition): void {
  for (const key of Object.keys(request.parameters))
    if (!definition.parameters?.some((parameter) => parameter.key === key))
      throw new Error(`Unknown action setting: ${key}`);
  for (const parameter of definition.parameters ?? [])
    if (parameter.required && !request.parameters[parameter.key]?.trim())
      throw new Error(`${parameter.label} is required`);
  if (definition.input && !request.input.trim())
    throw new Error("This native action needs an input");
  if (definition.nativeId && !request.nativeId?.trim())
    throw new Error("This native action needs its original session or job ID");
}

export class ToolActions {
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private closed = false;
  constructor(
    readonly store: ToolRunStore,
    private readonly adapters: readonly ToolActionAdapter[],
    private readonly resolveCommand: (command: string) => Promise<string>,
    private readonly maxConcurrent = 4,
    private readonly prepareContext?: (
      toolId: string,
      sessionId: string,
    ) => Promise<{ args: string[]; env: Record<string, string> }>,
  ) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32)
      throw new Error("Native action concurrency must be between 1 and 32");
    if (new Set(adapters.map((adapter) => adapter.id)).size !== adapters.length)
      throw new Error("Duplicate native tool adapter");
  }
  definitions() {
    return this.adapters.map((adapter) => ({
      toolId: adapter.id,
      actions: adapter.actions.map((action) => toolActionDefinition.parse(action)),
    }));
  }
  async start(raw: z.input<typeof startToolAction.input>) {
    if (this.closed) throw new Error("Native action service is closing");
    const { operationId, ...request } = startToolAction.input.parse(raw);
    const replay = this.store.replay(operationId, request);
    if (replay) return replay;
    const adapter = this.adapters.find((value) => value.id === request.toolId);
    const definition = adapter?.actions.find((value) => value.id === request.action);
    if (!adapter || !definition) throw new Error("This tool action is not supported");
    validateActionInput(request, definition);
    if (!path.isAbsolute(request.cwd) || !(await stat(request.cwd)).isDirectory())
      throw new Error("Choose an existing absolute project folder on this server");
    // Recheck after filesystem I/O: concurrent RPC retries may have completed meanwhile.
    const repeated = this.store.replay(operationId, request);
    if (repeated) return repeated;
    if (this.active.size >= this.maxConcurrent)
      throw new Error("Native action capacity reached. Wait for an active action to finish.");
    const run = this.store.create(operationId, request, definition.mutates !== false);
    const controller = new AbortController();
    const runDirectory = this.store.runDirectory(operationId);
    const task = (async () => {
      let transportStarted = false;
      try {
        await mkdir(runDirectory, { recursive: true, mode: 0o700 });
        controller.signal.throwIfAborted();
        const nativeContext = this.prepareContext
          ? await this.prepareContext(request.toolId, request.sessionId)
          : { args: [], env: {} as Record<string, string> };
        const result = toolActionResult.parse(
          await adapter.execute(request, {
            runDirectory,
            signal: controller.signal,
            nativeContext: async (toolId) => {
              if (toolId !== request.toolId)
                throw new Error("Native context belongs to a different tool");
              return nativeContext;
            },
            resolveCommand: async (command) => {
              if ((command === "claude" || command === "codex") && nativeContext.env.PATH) {
                const shim = path.join(nativeContext.env.PATH.split(path.delimiter)[0]!, command);
                try {
                  if ((await stat(shim)).isFile()) return shim;
                } catch {
                  /* Native command fallback keeps optional children independent. */
                }
              }
              return this.resolveCommand(command);
            },
            exec: (command) => {
              controller.signal.throwIfAborted();
              transportStarted = true;
              return executeCommand(
                {
                  ...command,
                  cwd: command.cwd ?? request.cwd,
                  env: { ...nativeContext.env, ...command.env },
                },
                controller.signal,
              );
            },
            request: (input) => {
              controller.signal.throwIfAborted();
              transportStarted = true;
              return requestHttp(input, controller.signal);
            },
          }),
        );
        if (Buffer.byteLength(result.text) > 65536)
          throw new Error(
            "Native result exceeds the 64 KiB connection limit; open its original history",
          );
        this.store.finish(operationId, result.state, result, null);
      } catch (error) {
        // A transport failure cannot prove whether the original runtime accepted a write.
        const message = error instanceof Error ? error.message : "Native tool action failed";
        this.store.finish(
          operationId,
          definition.mutates === false || !transportStarted ? "failed" : "unknown",
          null,
          message.slice(0, 2000),
        );
      } finally {
        this.active.delete(operationId);
      }
    })();
    this.active.set(operationId, { controller, task });
    return run;
  }
  cancel(id: string) {
    const run = this.store.read(id);
    this.active.get(id)?.controller.abort();
    return run.state === "running"
      ? this.store.finish(
          id,
          "unknown",
          null,
          "Cancellation requested. The original tool may have already accepted work; inspect its state.",
        )
      : run;
  }
  resolve(raw: z.input<typeof resolveToolRun.input>) {
    const input = resolveToolRun.input.parse(raw);
    if (this.active.has(input.id))
      throw new Error("Wait for this native action to stop before releasing its execution scope");
    return this.store.releaseUnknown(input.id, input.note);
  }
  async wait(id: string) {
    await this.active.get(id)?.task;
    return this.store.read(id);
  }
  async close() {
    this.closed = true;
    const tasks = [...this.active.values()];
    for (const { controller } of tasks) controller.abort();
    await Promise.allSettled(tasks.map(({ task }) => task));
    this.store.close();
  }
}
