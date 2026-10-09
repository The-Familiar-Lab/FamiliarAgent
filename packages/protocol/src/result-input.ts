import { z } from "zod";

export const RESULT_SEGMENT_LIMIT = 32;
export const RESULT_TEXT_BYTE_LIMIT = 64 * 1024;
export const RESULT_INSTRUCTION_BYTE_LIMIT = 16 * 1024;
export const RESULT_INPUT_BYTE_LIMIT = 96 * 1024;
export const RESULT_JOIN = "\n\n";
export const resultDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const bytes = z.number().int().positive().max(RESULT_TEXT_BYTE_LIMIT);
export const resultSegment = z.object({ sha256: resultDigest, bytes }).strict();
export const selectedResult = z
  .object({
    segments: z
      .array(
        resultSegment
          .extend({
            cursor: z
              .object({ epoch: z.string().min(1), seq: z.number().int().nonnegative() })
              .strict(),
            messageId: z.string().max(512).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(RESULT_SEGMENT_LIMIT),
    sha256: resultDigest,
    bytes,
  })
  .strict()
  .refine(validTotal, "Selected segment byte lengths do not match the response size");
export const resultSourceSelection = z
  .object({
    segments: z
      .array(resultSegment.extend({ ordinal: z.number().int().nonnegative() }).strict())
      .min(1)
      .max(RESULT_SEGMENT_LIMIT),
    sha256: resultDigest,
    bytes,
  })
  .strict()
  .refine(validTotal, "Selected segment byte lengths do not match the response size");
function validTotal(value: { segments: { bytes: number }[]; bytes: number }) {
  return (
    value.segments.reduce(
      (total, segment) => total + segment.bytes,
      2 * (value.segments.length - 1),
    ) === value.bytes
  );
}
export type SelectedResult = z.infer<typeof selectedResult>;
export type ResultSourceSelection = z.infer<typeof resultSourceSelection>;
