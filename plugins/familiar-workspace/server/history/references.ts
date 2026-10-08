import path from "node:path";
import { z } from "zod";
import type { HistorySummary } from "../../shared/history.js";

const absolutePath = z
  .string()
  .max(4096)
  .refine(path.isAbsolute, "History source must be an absolute path");
export const historyReference = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cursor-database"), path: absolutePath }),
  z.object({ kind: z.literal("vscode-json"), path: absolutePath }),
  z.object({ kind: z.literal("transcript-jsonl"), path: absolutePath }),
  z.object({ kind: z.literal("chatgpt-export"), path: absolutePath }),
  z.object({ kind: z.literal("antigravity-reader"), home: absolutePath }),
]);
export type HistoryReference = z.infer<typeof historyReference>;
export const LINKED_HISTORY_NOTE =
  "Linked to the original conversation on this server. Messages are read on demand; FamiliarAgent does not store a duplicate transcript.";
export const CACHED_HISTORY_NOTE =
  "Legacy cached copy from an earlier import. Scan history to link the original; this copy may be out of date.";

/** Upgrade known previous imports without inventing a location or using credentials. */
export function inferHistoryReference(summary: HistorySummary): HistoryReference | null {
  if (!path.isAbsolute(summary.origin)) return null;
  const file = summary.origin;
  if (file.endsWith(".jsonl")) return { kind: "transcript-jsonl", path: file };
  if (summary.source === "Cursor" && file.endsWith(".vscdb"))
    return { kind: "cursor-database", path: file };
  if (summary.source === "VSCode" && file.endsWith(".json"))
    return { kind: "vscode-json", path: file };
  if (summary.source === "ChatGPT" && file.endsWith(".json"))
    return { kind: "chatgpt-export", path: file };
  if (summary.source === "Antigravity" && file.endsWith(".pb")) {
    const segments = file.split(path.sep);
    const gemini = segments.lastIndexOf(".gemini");
    if (gemini > 0)
      return {
        kind: "antigravity-reader",
        home: segments.slice(0, gemini).join(path.sep) || path.sep,
      };
  }
  return null;
}
