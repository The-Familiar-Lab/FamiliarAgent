import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const id = z.string().min(1).max(160);
export const endpointActivity = z
  .object({
    endpointId: id,
    serverId: id,
    nativeId: id,
    toolId: z.string().max(200),
    kind: z.enum(["agent", "terminal", "web", "desktop", "tool"]),
    cwd: z.string().max(4096),
    workspaceId: id.optional(),
    state: z.enum(["starting", "running", "idle", "waiting", "closed", "unavailable", "external"]),
    readiness: z.enum(["ready", "unknown", "unavailable"]),
    source: z.enum(["native-agent", "native-terminal", "external-app", "native-action"]),
    detail: z.string().max(500),
  })
  .strict();
export const toolRunActivity = z
  .object({
    runId: id,
    toolId: z.string().max(200),
    action: z.string().max(200),
    cwd: z.string().max(4096),
    state: z.enum(["running", "completed", "submitted", "failed", "unknown"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    hasResult: z.boolean(),
  })
  .strict();
export const compositionActivity = z
  .object({
    sessionId: id,
    serverId: id,
    observedAt: z.string(),
    endpoints: z.array(endpointActivity).max(100),
    runs: z.array(toolRunActivity).max(50),
    totalRuns: z.number().int().nonnegative(),
  })
  .strict();
export type EndpointActivity = z.infer<typeof endpointActivity>;
export type ToolRunActivity = z.infer<typeof toolRunActivity>;
export type CompositionActivity = z.infer<typeof compositionActivity>;

/** Live observations stay on their owning host and are never persisted in session revisions. */
export const readCompositionActivity = defineRpc({
  name: "composition.activity",
  input: z
    .object({
      id,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  output: compositionActivity,
});
