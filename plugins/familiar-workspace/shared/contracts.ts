import { defineRpc, defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const spaceId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{N}_. -]+$/u);
export const workspaceDocument = z
  .object({
    id: spaceId,
    revision: z.number().int().nonnegative(),
    updatedAt: z.string(),
    notes: z.string().max(128 * 1024),
    mappings: z
      .array(
        z
          .object({
            machine: z.string().trim().min(1).max(200),
            path: z.string().trim().min(1).max(4096),
          })
          .strict(),
      )
      .max(64)
      .refine(
        (items) =>
          new Set(items.map((item) => `${item.machine}:${item.path}`)).size === items.length,
        "Duplicate machine mapping",
      ),
    tools: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(100),
            url: z
              .string()
              .url()
              .max(4096)
              .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
          })
          .strict(),
      )
      .max(32)
      .refine(
        (items) => new Set(items.map((item) => `${item.name}:${item.url}`)).size === items.length,
        "Duplicate native tool",
      ),
  })
  .strict();
export type WorkspaceDocument = z.infer<typeof workspaceDocument>;
export const readSpace = defineRpc({
  name: "space.read",
  input: z.object({ id: spaceId, forwarded: z.boolean().optional() }).strict(),
  output: workspaceDocument,
});
export const saveSpace = defineRpc({
  name: "space.save",
  input: workspaceDocument.extend({ forwarded: z.boolean().optional() }),
  output: workspaceDocument,
});
export const listSpaces = defineRpc({
  name: "space.list",
  input: z.object({ forwarded: z.boolean().optional() }).strict(),
  output: z.array(z.object({ id: spaceId, revision: z.number(), updatedAt: z.string() })),
});

export const agentStatus = defineRpc({
  name: "agent.status",
  input: z
    .object({ agentId: z.string().min(1), messageId: z.string().min(1).max(160).optional() })
    .strict(),
  output: z.object({
    agentId: z.string(),
    provider: z.string(),
    status: z.string(),
    cwd: z.string(),
    permissions: z.array(z.unknown()),
    recent: z.array(z.string()),
    assistantReply: z.object({ text: z.string(), truncated: z.boolean() }).nullable().optional(),
  }),
});
export const agentSend = defineRpc({
  name: "agent.send",
  input: z
    .object({
      agentId: z.string().min(1),
      text: z
        .string()
        .min(1)
        .max(128 * 1024),
      messageId: z.string().min(1).max(160),
    })
    .strict(),
  output: z.object({ accepted: z.literal(true), agentId: z.string() }),
});
export const agentPermission = defineRpc({
  name: "agent.permission",
  input: z
    .object({
      agentId: z.string().min(1),
      requestId: z.string().min(1),
      behavior: z.enum(["allow", "deny"]),
    })
    .strict(),
  output: z.object({ resolved: z.literal(true) }),
});
export const MAX_SHARED_FILE_BYTES = 4 * 1024 * 1024;
export const artifactPut = defineRpc({
  name: "artifact.put",
  input: z
    .object({
      name: z.string().min(1).max(255),
      base64: z.string().max(Math.ceil(MAX_SHARED_FILE_BYTES / 3) * 4),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
  output: z.object({ path: z.string(), size: z.number(), sha256: z.string() }),
});
export const artifactGet = defineRpc({
  name: "artifact.get",
  input: z.object({ agentId: z.string().min(1), path: z.string().min(1).max(4096) }).strict(),
  output: z.object({ name: z.string(), base64: z.string(), sha256: z.string(), size: z.number() }),
});

export const sharingSettings = defineSettings({
  id: "sharing",
  scope: "host",
  version: 1,
  schema: z
    .object({
      authority: z
        .string()
        .default("")
        .refine((value) => {
          if (!value) return true;
          try {
            const url = new URL(value);
            return (
              url.protocol === "ssh:" &&
              !url.password &&
              !url.hash &&
              (!url.pathname || url.pathname === "/")
            );
          } catch {
            return false;
          }
        }, "Use an SSH URI, such as ssh://server?daemonPort=6787"),
    })
    .default({ authority: "" }),
});
export const sharingSettingsRpc = settingsRpc("sharing");

export const providerSetup = defineRpc({
  name: "provider.setup",
  input: z.object({ provider: z.enum(["codex", "claude"]) }).strict(),
  output: z.object({ cwd: z.string(), command: z.string(), args: z.array(z.string()) }),
});
