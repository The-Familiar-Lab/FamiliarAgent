import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { localPath, toolId } from "./tool-catalog.js";

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/u);
const text = z
  .string()
  .max(96 * 1024)
  .refine((value) => !value.includes("\0"))
  .refine(
    (value) => new TextEncoder().encode(value).length <= 96 * 1024,
    "Native input exceeds 96 KiB",
  );
export const toolActionDefinition = z.object({
  id: toolId,
  label: z.string(),
  description: z.string(),
  input: z.boolean().optional(),
  inputMode: z.enum(["prompt", "command", "data"]).optional(),
  nativeId: z.boolean().optional(),
  mutates: z.boolean().optional(),
  parameters: z
    .array(
      z.object({
        key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u),
        label: z.string(),
        required: z.boolean().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});
export type ToolActionDefinition = z.infer<typeof toolActionDefinition>;
export const toolActionRequest = z
  .object({
    toolId,
    action: toolId,
    cwd: localPath,
    sessionId: id,
    input: text.default(""),
    nativeId: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !["\0", "\r", "\n"].some((character) => value.includes(character)))
      .optional(),
    parameters: z
      .record(
        z.string().max(80),
        z
          .string()
          .max(8192)
          .refine((value) => !value.includes("\0")),
      )
      .default({}),
  })
  .strict();
export const toolActionResult = z
  .object({
    state: z.enum(["completed", "submitted"]),
    text,
    nativeId: z.string().max(4096).optional(),
    artifacts: z
      .array(z.object({ path: localPath, label: z.string().max(256) }))
      .max(128)
      .optional(),
  })
  .strict();
export const toolRun = z
  .object({
    id,
    serverId: id,
    request: toolActionRequest,
    state: z.enum(["running", "completed", "submitted", "failed", "unknown"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    result: toolActionResult.nullable(),
    resultSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    error: z.string().max(2000).nullable(),
  })
  .strict();
export type ToolRun = z.infer<typeof toolRun>;
export const toolRunSummary = toolRun.extend({
  request: toolActionRequest.omit({ input: true }),
  result: toolActionResult
    .omit({ text: true })
    .extend({ preview: z.string().max(1000), textBytes: z.number().int().nonnegative() })
    .nullable(),
});
export type ToolRunSummary = z.infer<typeof toolRunSummary>;
export const listToolActions = defineRpc({
  name: "tools.actions",
  input: z.object({}).strict(),
  output: z.array(z.object({ toolId, actions: z.array(toolActionDefinition) })),
});
export const startToolAction = defineRpc({
  name: "tools.run.start",
  input: toolActionRequest.extend({ operationId: id }).strict(),
  output: toolRun,
});
export const readToolRun = defineRpc({
  name: "tools.run.read",
  input: z.object({ id }).strict(),
  output: toolRun,
});
export const cancelToolRun = defineRpc({
  name: "tools.run.cancel",
  input: z.object({ id }).strict(),
  output: toolRun,
});
export const listToolRuns = defineRpc({
  name: "tools.runs.list",
  input: z
    .object({
      sessionId: id,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  output: z.object({ runs: z.array(toolRunSummary), total: z.number().int().nonnegative() }),
});

export const readToolActionSettings = defineRpc({
  name: "tools.action-settings.read",
  input: toolActionRequest.pick({ toolId: true, action: true }).strict(),
  output: toolActionRequest.pick({ parameters: true }).strict(),
});
export const saveToolActionSettings = defineRpc({
  name: "tools.action-settings.save",
  input: toolActionRequest.pick({ toolId: true, action: true, parameters: true }).strict(),
  output: toolActionRequest.pick({ parameters: true }).strict(),
});
export const resolveToolRun = defineRpc({
  name: "tools.run.resolve",
  input: z
    .object({ id, originalChecked: z.literal(true), note: z.string().trim().min(1).max(1000) })
    .strict(),
  output: toolRun,
});
