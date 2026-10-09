import { z } from "zod";

export const TABS = [
  "Projects",
  "Sessions",
  "Inputs / Results",
  "Tools",
  "Memory & Skills",
  "Files",
  "Servers",
  "History",
] as const;
const bookmark = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1).max(200).nullable(),
    sessionId: z.string().min(1).max(200).nullable(),
    target: z.string().min(1).max(200),
    toolId: z.string().min(1).max(128),
    cwd: z.string().max(4096),
    title: z.string().max(200),
    tab: z.enum(TABS),
  })
  .strict()
  .refine((value) => !value.sessionId || !!value.projectId);
export type SetupReturn = z.infer<typeof bookmark>;
const MAX_BOOKMARK_BYTES = 16 * 1024;
const key = (catalogId: string) =>
  `familiar-workspace:setup-return:v1:${encodeURIComponent(catalogId)}`;

/** Only navigation coordinates are retained. Conversations and credentials stay with their owners. */
export function saveSetupReturn(catalogId: string, value: Omit<SetupReturn, "id">): void {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error("This client cannot preserve your session while opening setup.");
  storage.setItem(
    key(catalogId),
    JSON.stringify(bookmark.parse({ ...value, id: crypto.randomUUID() })),
  );
}
export function readSetupReturn(catalogId: string): SetupReturn | null {
  const raw = globalThis.localStorage?.getItem(key(catalogId));
  if (!raw) return null;
  if (raw.length > MAX_BOOKMARK_BYTES)
    throw new Error("Saved setup return information is too large.");
  return bookmark.parse(JSON.parse(raw));
}
export function consumeSetupReturn(catalogId: string, id: string): void {
  if (readSetupReturn(catalogId)?.id === id) globalThis.localStorage.removeItem(key(catalogId));
}

/** A broken auxiliary bookmark must never prevent ordinary navigation or Clear selection. */
export function discardSetupReturn(catalogId: string): void {
  try {
    globalThis.localStorage?.removeItem(key(catalogId));
  } catch {
    // Setup and restore report unavailable storage; manual navigation remains usable.
  }
}
