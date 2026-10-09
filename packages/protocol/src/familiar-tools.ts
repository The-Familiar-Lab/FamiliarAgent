import { z } from "zod";

/** The server supplies the same usage guidance to native launchers and plugin panels. */
export const toolGuideSchema = z.object({
  summary: z.string().min(1).max(1000),
  whenToUse: z.array(z.string().min(1).max(1000)).min(1).max(8),
  execution: z.string().min(1).max(1000),
  continuation: z.string().min(1).max(1500),
});
export type ToolGuide = z.infer<typeof toolGuideSchema>;
