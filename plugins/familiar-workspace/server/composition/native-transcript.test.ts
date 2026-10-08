import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { readNativeTranscript } from "./native-transcript.js";
import { localResourceReader } from "./readers.js";
import type { CompositionResource } from "../../shared/composition.js";
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe("original native transcript boundary", () => {
  it.each(["codex", "claude"])(
    "freezes an idle empty %s source before its transcript exists without admitting future turns",
    async (provider) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "familiar-empty-native-"));
      directories.push(root);
      vi.stubEnv(provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR", root);
      const source = {
        provider,
        status: "idle",
        lastUserMessageAt: null as string | null,
        persistence:
          provider === "codex"
            ? {
                provider,
                sessionId: "10000000-0000-4000-8000-000000000001",
                metadata: { emptyThread: true as boolean | undefined },
              }
            : null,
        runtimeInfo: {
          sessionId: provider === "codex" ? "10000000-0000-4000-8000-000000000001" : null,
        },
      };
      const head = {
        epoch: "empty",
        entries: [],
        endCursor: null,
        hasOlder: false,
        gap: false,
        staleCursor: false,
      };
      const refetch = vi.fn().mockResolvedValue(head);
      const refresh = vi.fn().mockResolvedValue({ agent: source });
      const paseo = {
        agents: {
          ref: () => ({ refresh, timeline: { refetch } }),
        },
      } as unknown as PaseoApi;
      const resource: CompositionResource = {
        id: "empty",
        kind: "history",
        label: "Empty native",
        serverId: "mac",
        format: "native-timeline",
        locator: "empty-agent",
        readOnly: true,
      };
      const reader = localResourceReader({ serverId: "mac", paseo, history: {} as never });
      const input = { offset: 0, limit: 1, maxCharacters: 256 };
      const captured = await reader(resource, { ...input, captureBoundary: true });
      expect(captured.boundary).toMatchObject({ kind: "native", prefix: { messageCount: 0 } });
      expect(captured.messages).toEqual([]);

      refresh.mockClear().mockRejectedValue(new Error("Archived source has no native transcript"));
      refetch.mockClear().mockRejectedValue(new Error("Archived source has no native transcript"));
      expect(await reader({ ...resource, boundary: captured.boundary }, input)).toMatchObject({
        messages: [],
        nextOffset: null,
      });
      expect(refresh).not.toHaveBeenCalled();
      expect(refetch).not.toHaveBeenCalled();
      await expect(reader(resource, { ...input, captureBoundary: true })).rejects.toThrow(
        "Archived source has no native transcript",
      );
      refresh.mockResolvedValue({ agent: source });
      refetch.mockResolvedValue(head);

      const persistence = source.persistence;
      if (source.persistence) source.persistence.metadata.emptyThread = undefined;
      else source.runtimeInfo.sessionId = "10000000-0000-4000-8000-000000000001";
      await expect(reader(resource, { ...input, captureBoundary: true })).rejects.toThrow();
      if (persistence) persistence.metadata.emptyThread = true;
      else source.runtimeInfo.sessionId = null;

      source.lastUserMessageAt = "2026-10-08T00:00:00Z";
      await expect(reader(resource, { ...input, captureBoundary: true })).rejects.toThrow();
      refetch.mockResolvedValue({
        ...head,
        epoch: "after-first-turn",
        endCursor: { epoch: "after-first-turn", seq: 1 },
        entries: [{ seqStart: 1, seqEnd: 1, item: { type: "user_message", text: "Future turn" } }],
      });
      const frozen = await reader({ ...resource, boundary: captured.boundary }, input);
      expect(frozen.messages).toEqual([]);
      expect(frozen.nextOffset).toBeNull();
      source.lastUserMessageAt = null;
      await expect(reader(resource, { ...input, captureBoundary: true })).rejects.toThrow();
    },
  );

  it.each(["codex", "claude"])(
    "pins %s original bytes across archive moves and rejects source rewrites",
    async (provider) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "familiar-native-source-"));
      directories.push(root);
      vi.stubEnv(provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR", root);
      const nativeId = "10000000-0000-4000-8000-000000000001";
      const directory = path.join(root, provider === "codex" ? "sessions" : "projects", "fixture");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `${nativeId}.jsonl`);
      const message = (text: string) =>
        provider === "codex"
          ? {
              type: "response_item",
              payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
            }
          : {
              type: "user",
              sessionId: nativeId,
              cwd: "/tmp/fixture",
              message: { role: "user", content: text },
            };
      const prefix =
        [
          ...(provider === "codex" ? [{ type: "session_meta", payload: { id: nativeId } }] : []),
          message("Before fork"),
        ]
          .map((value) => JSON.stringify(value))
          .join("\n") + "\n";
      await writeFile(file, prefix);
      const snapshot = { provider, persistence: { provider, sessionId: nativeId } } as PaseoAgent;
      const input = { offset: 0, limit: 10, maxCharacters: 1024 };
      const captured = await readNativeTranscript(snapshot, input, {
        kind: "native",
        epoch: "live",
        seq: 5,
      });
      expect(captured.boundary?.kind).toBe("native");
      if (captured.boundary?.kind !== "native") throw new Error("Missing native boundary");
      expect(captured.boundary.transcript?.file.bytes).toBe(Buffer.byteLength(prefix));
      const archivedDirectory = path.join(
        root,
        provider === "codex" ? "archived_sessions" : "projects/archive",
      );
      await mkdir(archivedDirectory, { recursive: true });
      const archived = path.join(archivedDirectory, `${nativeId}.jsonl`);
      await rename(file, archived);
      await appendFile(archived, JSON.stringify(message("After fork")) + "\n");
      const read = await readNativeTranscript(snapshot, input, captured.boundary);
      expect(read.messages.map((item) => item.text)).toEqual(["Before fork"]);
      await writeFile(archived, prefix.replace("Before fork", "Edited fork"));
      await expect(readNativeTranscript(snapshot, input, captured.boundary)).rejects.toThrow(
        "contents changed",
      );
    },
  );
});
