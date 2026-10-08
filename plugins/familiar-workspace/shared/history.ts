import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const historySource = z.enum([
  "Cursor",
  "VSCode",
  "Codex",
  "Claude",
  "Antigravity",
  "ChatGPT",
]);
export const historyMessage = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  text: z.string(),
  timestamp: z.string().optional(),
});
export const historySummary = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  nativeId: z.string(),
  source: historySource,
  title: z.string(),
  origin: z.string(),
  workspace: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  hidden: z.boolean(),
  notes: z.array(z.string()),
});
export const historyConversation = historySummary.extend({ messages: z.array(historyMessage) });
export type HistoryMessage = z.infer<typeof historyMessage>;
export type HistorySummary = z.infer<typeof historySummary>;
export type HistoryConversation = z.infer<typeof historyConversation>;
export type HistorySource = z.infer<typeof historySource>;
export const historyJob = z.object({
  running: z.boolean(),
  imported: z.number(),
  skipped: z.number(),
  errors: z.array(z.string()),
});
export const listHistory = defineRpc({
  name: "history.list",
  input: z.object({
    query: z.string().max(500).default(""),
    includeHidden: z.boolean().default(false),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ entries: z.array(historySummary), total: z.number(), job: historyJob }),
});
export const scanHistory = defineRpc({
  name: "history.scan",
  input: z.object({
    sources: z.array(historySource).optional(),
    exportPath: z.string().max(4096).optional(),
  }),
  output: historyJob,
});
export const readHistory = defineRpc({
  name: "history.read",
  input: z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(40),
  }),
  output: historySummary.extend({ messages: z.array(historyMessage), total: z.number() }),
});
export const hideHistory = defineRpc({
  name: "history.hide",
  input: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), hidden: z.boolean() }),
  output: historySummary,
});
export const exportHistory = defineRpc({
  name: "history.export",
  input: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }),
  output: z.object({ path: z.string() }),
});
