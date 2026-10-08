import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { connectToDaemon } from "../../utils/client.js";
import { describeDaemonTarget } from "../../utils/daemon-target.js";
import type { CommandOptions, SingleResult } from "../../output/index.js";

const forkInput = z.object({
  sourceId: z.string().min(1),
  sourceHost: z.string().min(1),
  targetHost: z.string().min(1),
  cwd: z.string().min(1),
  provider: z.string().min(1).optional(),
  prompt: z
    .string()
    .min(1)
    .max(128 * 1024),
  operationId: z.string().min(1).max(160),
  maxContextBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024)
    .default(1024 * 1024),
});
type ForkInput = z.input<typeof forkInput>;
type Source = Pick<DaemonClient, "fetchAgent" | "buildAgentForkContext">;
type Target = Pick<DaemonClient, "createWorkspace">;
/** Reuse the native portable chat-history attachment; no provider session files or credentials move. */
export async function forkContextToHost(source: Source, target: Target, raw: ForkInput) {
  const input = forkInput.parse(raw);
  const snapshot = await source.fetchAgent(input.sourceId);
  if (!snapshot) throw new Error("Source agent not found");
  const history = await source.buildAgentForkContext(input.sourceId);
  if (history.error || !history.attachment)
    throw new Error(history.error ?? "Source has no portable conversation context");
  if (Buffer.byteLength(history.attachment.text) > input.maxContextBytes)
    throw new Error(
      "Conversation exceeds the fork context limit. Fork from a shorter boundary or increase the explicit limit.",
    );
  const result = await target.createWorkspace({
    source: { kind: "directory", path: input.cwd },
    title: `Fork: ${snapshot.agent.title ?? "conversation"}`,
    idempotencyKey: `familiar-fork:${input.operationId}`,
    agent: {
      config: { provider: input.provider ?? snapshot.agent.provider, cwd: input.cwd },
      initialPrompt: input.prompt,
      attachments: [
        history.attachment,
        {
          type: "text",
          mimeType: "text/plain",
          title: "FamiliarAgent fork origin",
          text: JSON.stringify({
            mode: "portable-context",
            sourceHost: input.sourceHost,
            sourceAgentId: input.sourceId,
            sourceDirectory: snapshot.agent.cwd,
            targetDirectory: input.cwd,
            operationId: input.operationId,
          }),
        },
      ],
      clientMessageId: `familiar-fork:${input.operationId}`,
      labels: {
        "familiar.fork.source": input.sourceId,
        "familiar.fork.operation": input.operationId,
      },
    },
  });
  if (result.error || !result.agent || !result.workspace)
    throw new Error(result.error ?? "Target did not return the forked session");
  return {
    agentId: result.agent.id,
    workspaceId: result.workspace.id,
    provider: result.agent.provider,
    host: input.targetHost,
    mode: "portable-context" as const,
    operationId: input.operationId,
    status: "created" as const,
  };
}
export function addForkOptions(command: Command) {
  return command
    .description(
      "Fork native conversation context onto another host or provider; source remains unchanged",
    )
    .argument("<id>", "Source agent ID")
    .requiredOption("--target-host <host>", "Destination daemon endpoint or SSH URI")
    .requiredOption("--cwd <path>", "Existing destination project directory")
    .requiredOption("--prompt <text>", "First instruction in the new session")
    .option("--provider <provider>", "Destination provider; defaults to the source provider")
    .option(
      "--operation-id <id>",
      "Reuse this ID after a lost acknowledgement to prevent duplicate forks",
    )
    .option("--max-context-bytes <bytes>", "Explicit context transfer limit", "1048576");
}
interface ForkOptions extends CommandOptions {
  targetHost?: string;
  cwd?: string;
  prompt?: string;
  provider?: string;
  operationId?: string;
  maxContextBytes?: string;
}
export async function runForkCommand(
  id: string,
  options: ForkOptions,
  _command: Command,
): Promise<SingleResult<Awaited<ReturnType<typeof forkContextToHost>>>> {
  const operationId = options.operationId ?? randomUUID();
  const parsed = forkInput.parse({
    sourceId: id,
    sourceHost: describeDaemonTarget(options.daemonTarget),
    targetHost: options.targetHost,
    cwd: options.cwd,
    prompt: options.prompt,
    provider: options.provider,
    operationId,
    maxContextBytes: options.maxContextBytes,
  });
  const targetDescriptor = { kind: "endpoint" as const, host: parsed.targetHost };
  const source = await connectToDaemon({ target: options.daemonTarget });
  let target: DaemonClient | undefined;
  try {
    target = await connectToDaemon({ target: targetDescriptor });
    const data = await forkContextToHost(source, target, {
      ...parsed,
      targetHost: describeDaemonTarget(targetDescriptor),
    });
    return {
      type: "single",
      data,
      schema: {
        idField: "agentId",
        columns: [
          { header: "AGENT", field: "agentId", width: 38 },
          { header: "MODE", field: "mode", width: 18 },
          { header: "OPERATION", field: "operationId", width: 38 },
        ],
      },
    };
  } catch (error) {
    let detail = String(error);
    if (typeof error === "object" && error !== null && "message" in error) {
      detail = String(error.message);
    }
    throw new Error(
      `Fork was not confirmed. Inspect the destination before retrying; reuse --operation-id ${operationId}. ${detail}`,
      { cause: error },
    );
  } finally {
    await Promise.all([source.close(), target?.close()]);
  }
}
