import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { compositionResource } from "./composition.js";
import {
  resultDigest,
  resultSourceSelection,
  selectedResult,
  RESULT_INSTRUCTION_BYTE_LIMIT,
} from "./result-selection.js";

const id = z.string().min(1).max(160);
const sessionInput = { id, forwarded: z.boolean().optional() };
export const resultAnchor = z
  .object({
    resource: compositionResource,
    selection: resultSourceSelection,
  })
  .strict();
export const compositionResult = z
  .object({
    id,
    sessionId: id,
    sourceEndpointId: id,
    createdAt: z.string(),
    anchor: resultAnchor,
    preview: z.string().max(240),
  })
  .strict();
export const compositionInput = z
  .object({
    id,
    sessionId: id,
    resultId: id,
    targetEndpointId: id,
    targetServerId: id,
    targetAgentId: id,
    instruction: z.string().max(RESULT_INSTRUCTION_BYTE_LIMIT),
    inputSha256: resultDigest,
    state: z.enum(["prepared", "accepted", "failed", "unknown"]),
    revision: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
    error: z.string().max(2000).nullable(),
  })
  .strict();
export const compositionInputRecord = z.object({
  result: compositionResult,
  input: compositionInput,
});
export type ResultAnchor = z.infer<typeof resultAnchor>;
export type CompositionResult = z.infer<typeof compositionResult>;
export type CompositionInput = z.infer<typeof compositionInput>;
export const previewCompositionResult = defineRpc({
  name: "composition.result.preview",
  input: z.object({ agentId: id, selection: selectedResult }).strict(),
  output: z.object({ text: z.string() }),
});
export const captureCompositionResult = defineRpc({
  name: "composition.result.capture",
  input: z.object({ agentId: id, selection: selectedResult }).strict(),
  output: z.object({ anchor: resultAnchor, text: z.string() }),
});
export const prepareCompositionInput = defineRpc({
  name: "composition.input.prepare",
  input: z
    .object({
      ...sessionInput,
      operationId: id,
      expectedRevision: z.number().int().positive(),
      sourceEndpointId: id,
      anchor: resultAnchor,
      targetEndpointId: id,
      instruction: z.string().max(RESULT_INSTRUCTION_BYTE_LIMIT),
    })
    .strict(),
  output: compositionInputRecord.extend({ text: z.string() }),
});
export const readCompositionInput = defineRpc({
  name: "composition.input.read",
  input: z.object({ ...sessionInput, inputId: id }).strict(),
  output: compositionInputRecord,
});
export const listCompositionInputs = defineRpc({
  name: "composition.inputs.list",
  input: z
    .object({
      ...sessionInput,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  output: z.object({
    records: z.array(compositionInputRecord),
    total: z.number().int().nonnegative(),
  }),
});
export const readCompositionResult = defineRpc({
  name: "composition.result.read",
  input: z.object({ ...sessionInput, resultId: id }).strict(),
  output: z.object({ result: compositionResult, text: z.string() }),
});
export const sendCompositionInput = defineRpc({
  name: "composition.input.send",
  input: z.object({ id, inputId: id }).strict(),
  output: compositionInputRecord,
});
export const reconcileCompositionInput = defineRpc({
  name: "composition.input.reconcile",
  input: z.object({ id, inputId: id }).strict(),
  output: compositionInputRecord,
});
// Internal catalog transitions: session-scoped return paths carry these, never a second send.
export const claimCompositionInput = defineRpc({
  name: "composition.input.claim",
  input: z.object({ ...sessionInput, inputId: id, targetServerId: id }).strict(),
  output: compositionInputRecord.extend({ claimed: z.boolean(), token: id.optional() }),
});
export const finishCompositionInput = defineRpc({
  name: "composition.input.finish",
  input: z
    .object({
      ...sessionInput,
      inputId: id,
      token: id,
      targetServerId: id,
      targetAgentId: id,
      state: z.enum(["accepted", "failed", "unknown"]),
      error: z.string().max(2000).nullable(),
    })
    .strict(),
  output: compositionInputRecord,
});
