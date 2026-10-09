import { z } from "zod";
import type { ToolSetupStatus } from "../../shared/tool-setup.js";

const draft = z.object({
  serverId: z.string().max(200),
  toolIds: z.array(z.string().min(1).max(128)).max(64),
  step: z.number().int().min(1).max(4),
  dismissed: z.boolean(),
});
export type SetupDraft = z.infer<typeof draft>;
const key = (id: string) => `familiar-workspace:onboarding:v1:${encodeURIComponent(id)}`;

export function readSetupDraft(id: string): SetupDraft | null {
  try {
    const value = globalThis.localStorage?.getItem(key(id));
    if (!value || value.length > 16 * 1024) return null;
    return draft.parse(JSON.parse(value));
  } catch {
    return null;
  }
}
export function saveSetupDraft(id: string, value: SetupDraft): void {
  try {
    globalThis.localStorage?.setItem(key(id), JSON.stringify(draft.parse(value)));
  } catch {
    // This optional navigation preference must not prevent installation or login.
  }
}
export function setupReadiness(status: ToolSetupStatus): string {
  if (status.installation !== "installed") return "Install needed";
  switch (status.account) {
    case "signed-in":
      return "Installed · signed in";
    case "sign-in-required":
      return "Installed · sign in needed";
    case "not-required":
      return "Installed · no account check required";
    default:
      return "Installed · account not verified";
  }
}
