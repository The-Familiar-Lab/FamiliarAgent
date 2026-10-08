import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const toolId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/u);
const argument = z
  .string()
  .max(16384)
  .refine((value) => !value.includes("\0"), "NUL is not allowed");
export const executable = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !["\0", "\r", "\n"].some((character) => value.includes(character)));
export const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !["\0", "\r", "\n"].some((character) => value.includes(character)));
export const webUrl = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  }, "Use an HTTP(S) URL without embedded credentials");
export const toolCapability = z.enum([
  "harness",
  "context",
  "skills",
  "mcp",
  "orchestration",
  "workspace",
  "git",
]);
export const nativeLaunch = z
  .object({
    command: executable,
    args: z.array(argument).max(128).default([]),
  })
  .strict();
export const toolRegistration = z
  .object({
    id: toolId,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1000).default(""),
    capabilities: z.array(toolCapability).max(7).default([]),
    launch: nativeLaunch.optional(),
    url: webUrl.optional(),
    sourceUrl: webUrl.optional(),
  })
  .strict()
  .refine((value) => value.launch || value.url, "A command or web URL is required");
export type ToolRegistration = z.infer<typeof toolRegistration>;
export const toolEntry = z.object({
  id: toolId,
  name: z.string(),
  description: z.string(),
  capabilities: z.array(toolCapability),
  modes: z.array(z.enum(["agent", "terminal", "web", "desktop", "reference"])),
  nativeProvider: z.string().optional(),
  sourceUrl: webUrl.optional(),
  license: z.string(),
  custom: z.boolean(),
  installed: z.boolean(),
  executablePath: z.string().optional(),
  url: webUrl.optional(),
  installAvailable: z.boolean(),
  installReason: z.string().optional(),
  notes: z.array(z.string()),
});
export type ToolEntry = z.infer<typeof toolEntry>;
export const toolPlan = z.object({
  toolId,
  action: z.enum(["launch", "install"]),
  mode: z.enum(["terminal", "web", "desktop"]),
  cwd: localPath,
  command: executable.optional(),
  args: z.array(argument).default([]),
  url: webUrl.optional(),
  notes: z.array(z.string()),
});
export type ToolPlan = z.infer<typeof toolPlan>;
export const writeToolContext = defineRpc({
  name: "tools.context",
  input: z
    .object({
      sessionId: z.string().min(1).max(160),
      text: z.string().max(16 * 1024),
    })
    .strict(),
  output: z.object({
    path: localPath,
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
});
export const listTools = defineRpc({
  name: "tools.list",
  input: z.object({}).strict(),
  output: z.array(toolEntry),
});
export const registerTool = defineRpc({
  name: "tools.register",
  input: toolRegistration,
  output: toolEntry,
});
export const removeTool = defineRpc({
  name: "tools.remove",
  input: z.object({ id: toolId }).strict(),
  output: z.object({ removed: z.boolean() }),
});
export const prepareTool = defineRpc({
  name: "tools.prepare",
  input: z
    .object({
      id: toolId,
      action: z.enum(["launch", "install"]),
      cwd: localPath,
      surface: z.enum(["terminal", "web", "desktop"]).optional(),
      contextPath: localPath.optional(),
      sessionId: z
        .string()
        .min(1)
        .max(160)
        .refine((value) => !value.includes("\0"))
        .optional(),
    })
    .strict(),
  output: toolPlan,
});

export const sharedSkill = z
  .object({ id: toolId, path: localPath, enabled: z.boolean().default(true) })
  .strict();
export const sharedHttpMcp = z
  .object({
    id: toolId,
    type: z.literal("http"),
    url: webUrl,
    enabled: z.boolean().default(true),
  })
  .strict();
export const crossHostHttpMcp = sharedHttpMcp.refine((entry) => {
  const hostname = new URL(entry.url).hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  return !(
    ["localhost", "0.0.0.0", "::", "::1", "::ffff:0:0"].includes(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.") ||
    /^::ffff:7f[\da-f]{2}:/u.test(hostname)
  );
}, "Use an address reachable from every selected server; local or loopback URLs require a separate server mapping.");
export const sharedMcp = z.discriminatedUnion("type", [
  z
    .object({
      id: toolId,
      type: z.literal("stdio"),
      command: executable,
      args: z.array(argument).max(128).default([]),
      enabled: z.boolean().default(true),
    })
    .strict(),
  sharedHttpMcp,
]);
export const resourceDocument = z
  .object({
    revision: z.number().int().nonnegative(),
    skills: z.array(sharedSkill).max(256),
    mcp: z.array(sharedMcp).max(64),
  })
  .strict()
  .refine(
    (value) => new Set(value.skills.map((skill) => skill.id)).size === value.skills.length,
    "Duplicate skill ID",
  )
  .refine(
    (value) => new Set(value.mcp.map((mcp) => mcp.id)).size === value.mcp.length,
    "Duplicate MCP ID",
  );
export type ResourceDocument = z.infer<typeof resourceDocument>;
export const listResources = defineRpc({
  name: "resources.list",
  input: z.object({}).strict(),
  output: resourceDocument,
});
export const saveResources = defineRpc({
  name: "resources.save",
  input: resourceDocument,
  output: resourceDocument,
});
export const useHttpResource = defineRpc({
  name: "resources.use-http",
  input: z
    .object({ expectedRevision: z.number().int().nonnegative(), entry: crossHostHttpMcp })
    .strict(),
  output: z
    .object({ status: z.enum(["added", "unchanged"]), resources: resourceDocument })
    .strict(),
});
export const projectResources = defineRpc({
  name: "resources.project",
  input: z
    .object({
      cwd: localPath,
      toolId: z.enum(["claude", "codex", "cursor"]),
      remove: z.boolean().default(false),
    })
    .strict(),
  output: z.object({
    paths: z.array(z.string()),
    unchanged: z.array(z.string()),
    conflicts: z.array(z.string()),
    removed: z.array(z.string()),
    notes: z.array(z.string()),
  }),
});
