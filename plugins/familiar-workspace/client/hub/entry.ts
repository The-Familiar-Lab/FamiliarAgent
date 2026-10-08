import type { input, output } from "zod";
import type { listComposition } from "../../shared/composition.js";

export const CATALOG_PAGE_SIZE = 100;
export async function findNativeSession(
  serverId: string,
  agentId: string,
  list: (
    input: input<typeof listComposition.input>,
  ) => Promise<output<typeof listComposition.output>>,
) {
  let offset = 0;
  while (true) {
    const page = await list({ offset, limit: CATALOG_PAGE_SIZE });
    const match = page.sessions.find((session) =>
      session.endpoints.some(
        (endpoint) => endpoint.serverId === serverId && endpoint.agentId === agentId,
      ),
    );
    if (match) return match;
    offset += page.sessions.length;
    if (!page.sessions.length || offset >= page.total) return null;
  }
}

/** Let the native workspace service resolve a valid base branch; literal HEAD is rejected. */
export function forkWorktree(id: string) {
  return { mode: "branch-off" as const, newBranch: `familiar-${id}` };
}
