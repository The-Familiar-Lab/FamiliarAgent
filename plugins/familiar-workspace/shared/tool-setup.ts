import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { localPath, sharedSkill, toolId, toolPlan } from "./tool-catalog.js";

export const setupAction = z.enum([
  "install",
  "login",
  "configure",
  "start",
  "api-key",
  "apply-key",
  "use-codex",
  "use-claude",
  "use-goose-profile",
]);
export const apiKeyProvider = z.enum(["openai", "anthropic", "openrouter"]);
export const toolSetupStatus = z.object({
  toolId,
  checkedAt: z.string(),
  installation: z.enum(["installed", "missing"]),
  account: z.enum(["signed-in", "sign-in-required", "not-checked", "not-required"]),
  message: z.string(),
  details: z.array(z.string()),
  actions: z.array(z.object({ id: setupAction, label: z.string() })),
});
export type ToolSetupStatus = z.infer<typeof toolSetupStatus>;
export const readSetupWorkspace = defineRpc({
  name: "tools.setup.workspace",
  input: z.object({}).strict(),
  output: z.object({ cwd: localPath }),
});
export const readToolSetup = defineRpc({
  name: "tools.setup.status",
  input: z.object({ id: toolId }).strict(),
  output: toolSetupStatus,
});
export const prepareToolSetup = defineRpc({
  name: "tools.setup.prepare",
  input: z
    .object({ id: toolId, action: setupAction, provider: apiKeyProvider.optional() })
    .strict(),
  output: z.object({
    plan: toolPlan.optional(),
    settings: z
      .array(z.object({ action: z.string(), parameters: z.record(z.string(), z.string()) }))
      .optional(),
    credentialFile: localPath.optional(),
    skills: z.array(sharedSkill).max(256).optional(),
  }),
});
