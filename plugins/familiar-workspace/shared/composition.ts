import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { resultSourceSelection } from "./result-selection.js";

const id = z.string().min(1).max(160);
const revision = z.number().int().positive();
const operation = { operationId: id, forwarded: z.boolean().optional() };
const connection = z.string().min(1).max(4096).optional();
export const resourceKind = z.enum([
  "codebase",
  "history",
  "memory",
  "skill",
  "mcp",
  "tool",
  "artifact",
]);
const transcriptFileBoundary = z
  .object({
    identity: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const historyBoundary = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tool"),
      toolId: id,
      sessionId: id,
      cwd: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("native"),
      epoch: z.string(),
      seq: z.number().int().nonnegative(),
      transcript: z
        .object({
          source: z.enum(["Codex", "Claude"]),
          nativeId: id,
          messageCount: z.number().int().nonnegative(),
          file: transcriptFileBoundary,
        })
        .strict()
        .optional(),
      prefix: z
        .object({
          messageCount: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("imported"),
      messageCount: z.number().int().nonnegative(),
      updatedAt: z.string(),
      file: transcriptFileBoundary.optional(),
    })
    .strict(),
]);
export type HistoryBoundary = z.infer<typeof historyBoundary>;
export const compositionResource = z
  .object({
    id,
    kind: resourceKind,
    label: z.string().trim().min(1).max(200),
    serverId: id,
    connection,
    format: z
      .enum(["native-timeline", "imported-history", "tool-result", "path", "url"])
      .optional(),
    boundary: historyBoundary.optional(),
    // A native path, URL or native object ID; this is a reference, never executable code.
    locator: z.string().min(1).max(4096),
    readOnly: z.boolean().default(true),
  })
  .strict();
export const compositionEndpoint = z
  .object({
    id,
    serverId: id,
    connection,
    agentId: id,
    kind: z.enum(["agent", "terminal", "web", "desktop", "tool"]).default("agent"),
    workspaceId: id.optional(),
    url: z.string().max(4096).optional(),
    provider: z.string().min(1).max(100),
    cwd: z.string().min(1).max(4096),
    model: z.string().max(200).optional(),
    harness: z.string().max(200).optional(),
    createdAt: z.string(),
  })
  .strict();
const resources = z
  .array(compositionResource)
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Resource IDs must be unique",
  );
export const compositionProject = z
  .object({
    id,
    title: z.string().trim().min(1).max(200),
    revision,
    updatedAt: z.string(),
    memory: z.string().max(64 * 1024),
    resources,
  })
  .strict();
export const compositionSession = z
  .object({
    id,
    projectId: id,
    title: z.string().trim().min(1).max(200),
    revision,
    createdAt: z.string(),
    updatedAt: z.string(),
    memory: z.string().max(64 * 1024),
    resources,
    memoryEnabled: z.boolean().optional(),
    disabledResourceIds: z.array(id).max(100).optional(),
    endpoints: z.array(compositionEndpoint).max(100),
    activeEndpointId: id.nullable(),
    parent: z
      .object({
        sessionId: id,
        revision,
        shareMemory: z.boolean(),
        shareKinds: z.array(resourceKind).max(7),
        historyBoundaries: z.record(id, historyBoundary).default({}),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CompositionProject = z.infer<typeof compositionProject>;
export type CompositionSession = z.infer<typeof compositionSession>;
export type CompositionResource = z.infer<typeof compositionResource>;
export type CompositionEndpoint = z.infer<typeof compositionEndpoint>;
export const compositionSessionSummary = compositionSession
  .omit({ memory: true, resources: true })
  .extend({
    resourceCount: z.number().int().nonnegative(),
    memoryCharacters: z.number().int().nonnegative(),
  });
export const compositionProjectSummary = compositionProject
  .omit({ memory: true, resources: true })
  .extend({
    resourceCount: z.number().int().nonnegative(),
    memoryCharacters: z.number().int().nonnegative(),
  });

export const listComposition = defineRpc({
  name: "composition.list",
  input: z
    .object({
      query: z.string().max(500).default(""),
      projectId: id.optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(50),
      forwarded: z.boolean().optional(),
    })
    .strict(),
  output: z.object({
    projects: z.array(compositionProjectSummary),
    sessions: z.array(compositionSessionSummary),
    total: z.number().int().nonnegative(),
  }),
});
export const readCompositionProject = defineRpc({
  name: "composition.project.read",
  input: z.object({ id, forwarded: z.boolean().optional() }).strict(),
  output: compositionProject,
});
export const saveCompositionProject = defineRpc({
  name: "composition.project.save",
  input: compositionProject.omit({ revision: true, updatedAt: true }).extend({
    ...operation,
    expectedRevision: z.number().int().nonnegative(),
  }),
  output: compositionProject,
});
export const createComposition = defineRpc({
  name: "composition.create",
  input: z
    .object({
      ...operation,
      projectId: id,
      title: z.string().trim().min(1).max(200),
      memory: z
        .string()
        .max(64 * 1024)
        .default(""),
      resources: resources.default([]),
      endpoint: compositionEndpoint.omit({ id: true, createdAt: true }).optional(),
    })
    .strict(),
  output: compositionSession,
});
export const readComposition = defineRpc({
  name: "composition.read",
  input: z
    .object({ id, revision: revision.optional(), forwarded: z.boolean().optional() })
    .strict(),
  output: compositionSession,
});
export const updateComposition = defineRpc({
  name: "composition.update",
  input: z
    .object({
      ...operation,
      id,
      expectedRevision: revision,
      title: z.string().trim().min(1).max(200),
      memory: z.string().max(64 * 1024),
      resources,
      memoryEnabled: z.boolean().optional(),
      disabledResourceIds: z.array(id).max(100).optional(),
    })
    .strict(),
  output: compositionSession,
});
export const bindComposition = defineRpc({
  name: "composition.bind",
  input: z
    .object({
      ...operation,
      id,
      expectedRevision: revision,
      endpoint: compositionEndpoint.omit({ id: true, createdAt: true }),
    })
    .strict(),
  output: compositionSession,
});
export const forkComposition = defineRpc({
  name: "composition.fork",
  input: z
    .object({
      ...operation,
      id,
      expectedRevision: revision,
      title: z.string().trim().min(1).max(200),
      shareMemory: z.boolean().default(true),
      shareKinds: z.array(resourceKind).max(7).default(resourceKind.options),
      endpoint: compositionEndpoint.omit({ id: true, createdAt: true }).optional(),
    })
    .strict(),
  output: compositionSession,
});
export const compositionContext = z.object({
  sessionId: id,
  revision,
  project: compositionProjectSummary,
  lineage: z.array(z.object({ sessionId: id, revision })),
  memories: z.array(z.object({ source: id, text: z.string() })),
  resources: z.array(compositionResource.extend({ inheritedFrom: id })),
  truncated: z.boolean(),
  continuation: z.string(),
});
export const readCompositionContext = defineRpc({
  name: "composition.context",
  input: z
    .object({
      id,
      revision: revision.optional(),
      maxCharacters: z
        .number()
        .int()
        .min(256)
        .max(64 * 1024)
        .default(16 * 1024),
      maxResources: z.number().int().min(1).max(200).default(100),
      forwarded: z.boolean().optional(),
    })
    .strict(),
  output: compositionContext,
});

export const compositionResourcePage = z.object({
  resource: compositionResource,
  messages: z.array(
    z.object({ role: z.string(), text: z.string(), timestamp: z.string().optional() }),
  ),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
});
export const readCompositionResource = defineRpc({
  name: "composition.resource.read",
  input: z
    .object({
      id,
      revision: revision.optional(),
      resourceId: id,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(20),
      maxCharacters: z
        .number()
        .int()
        .min(256)
        .max(64 * 1024)
        .default(16 * 1024),
      forwarded: z.boolean().optional(),
    })
    .strict(),
  output: compositionResourcePage,
});
export const locateCompositionResource = defineRpc({
  name: "composition.resource.locate",
  input: z
    .object({
      id,
      revision: revision.optional(),
      resourceId: id,
      forwarded: z.boolean().optional(),
    })
    .strict(),
  output: compositionResource,
});

// Reads an explicitly supplied native reference on its owning host. It never follows authority settings.
export const readCompositionSource = defineRpc({
  name: "composition.source.read",
  input: z
    .object({
      resource: compositionResource,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(20),
      maxCharacters: z
        .number()
        .int()
        .min(256)
        .max(64 * 1024)
        .default(16 * 1024),
      captureBoundary: z.boolean().optional(),
      selection: resultSourceSelection.optional(),
      forwarded: z.boolean().optional(),
    })
    .strict(),
  output: compositionResourcePage,
});

export const ensureCompositionBridge = defineRpc({
  name: "composition.bridge.ensure",
  input: z
    .object({
      target: z.string().min(1).max(4096),
      targetServerId: id,
      resources: z.array(compositionResource).max(100).default([]),
      sessions: z.array(id).max(100).default([]),
      catalogAuthority: z.string().max(4096).optional(),
    })
    .strict(),
  output: z.object({
    sourceServerId: id,
    targetServerId: id,
    active: z.literal(true),
    sharedReferences: z.number().int().nonnegative(),
    linkedSessions: z.number().int().nonnegative().default(0),
  }),
});
export const compositionBridgeCredential = z
  .object({
    sourceServerId: id,
    targetServerId: id,
    port: z.number().int().min(1).max(65535),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
    sessions: z.array(id).max(1000).default([]),
    resourceServerIds: z.array(id).max(1000).default([]),
  })
  .strict();
// Credential stays in private daemon storage and is never returned by list/context RPCs.
export const installCompositionBridge = defineRpc({
  name: "composition.bridge.install",
  input: compositionBridgeCredential.extend({ forwarded: z.boolean().optional() }),
  output: z.object({ installed: z.literal(true) }),
});
export const compositionRuntime = defineRpc({
  name: "composition.runtime",
  input: z.object({ sessionId: id, readOnly: z.boolean().optional() }).strict(),
  output: z.object({
    mcpServers: z.object({
      familiar_context: z.object({
        type: z.literal("stdio"),
        command: z.string(),
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()),
      }),
    }),
  }),
});
