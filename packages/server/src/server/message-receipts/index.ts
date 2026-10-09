import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentMessageReceipt } from "@getpaseo/protocol/messages";
import { AgentMessageRejectedError } from "../agent/message-rejection.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed", "rejected"]),
  agentId: z.string(),
  error: z.string().optional(),
  code: z.string().optional(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}

  async lookup(
    input: Pick<SendMessageInput, "agentId" | "messageId" | "request">,
  ): Promise<AgentMessageReceipt> {
    const key = digest(["send", input.agentId, input.messageId]);
    const receipt = await readReceipt(path.join(this.directory, `${key}.json`));
    if (!receipt) return { state: "absent", error: null, code: null };
    assertFingerprint(receipt.fingerprint, digest(input.request));
    return { state: receipt.state, error: receipt.error ?? null, code: receipt.code ?? null };
  }

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      assertFingerprint(existing.fingerprint, fingerprint);
      if (existing.state === "completed") return;
      if (existing.state === "rejected") {
        throw new AgentMessageRejectedError(
          existing.code ?? "agent_message_rejected",
          existing.error ?? "Agent message was rejected before dispatch",
        );
      }
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    try {
      await input.prepare?.();
    } catch (error) {
      throw new AgentMessageRejectedError(
        "agent_message_prepare_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    const receipt = { fingerprint, agentId: input.agentId };
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    try {
      await input.send();
    } catch (error) {
      if (error instanceof AgentMessageRejectedError) {
        await writeJsonFileAtomic(file, {
          ...receipt,
          state: "rejected",
          error: error.message,
          code: error.code,
        });
      }
      throw error;
    }
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
  }
}

function assertFingerprint(existing: string, expected: string): void {
  if (existing !== expected) {
    throw new AgentMessageRejectedError("agent_request_key_conflict", "agent_request_key_conflict");
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
