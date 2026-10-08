import {
  readComposition,
  readCompositionContext,
  locateCompositionResource,
  updateComposition,
} from "../../shared/composition.js";

export type CatalogInvoke = (
  method: string,
  input: Record<string, unknown>,
  authority?: string,
) => Promise<unknown>;

const contracts = [
  readComposition,
  readCompositionContext,
  locateCompositionResource,
  updateComposition,
];

/** A linked runtime may read its session and change its memory, never remap sources or endpoints. */
export async function scopedCatalogCall(
  raw: unknown,
  sessions: ReadonlyMap<string, string | undefined>,
  invoke: CatalogInvoke,
) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid session context request");
  const request = raw as { method?: unknown; input?: unknown };
  const contract = contracts.find((item) => item.name === request.method);
  if (!contract) throw new Error("Method is not available through a session context link");
  const input = contract.input.parse(request.input);
  if (input.forwarded) throw new Error("Session context links cannot forward another link");
  if (!sessions.has(input.id)) throw new Error("Session is outside this context link");
  const authority = sessions.get(input.id);
  if (contract.name === updateComposition.name) {
    const update = updateComposition.input.parse(input);
    const current = readComposition.output.parse(
      await invoke(readComposition.name, { id: input.id }, authority),
    );
    if (
      update.title !== current.title ||
      JSON.stringify(update.resources) !== JSON.stringify(current.resources)
    )
      throw new Error("A session context link can update shared memory only");
  }
  return contract.output.parse(await invoke(contract.name, input, authority));
}
