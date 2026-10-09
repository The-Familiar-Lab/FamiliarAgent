import type { CompositionResource, CompositionSession } from "../../shared/composition.js";

export interface SkillSelection {
  serverId: string;
  connection?: string;
  skillId: string;
}
const matches = (resource: CompositionResource, source: SkillSelection) =>
  resource.kind === "skill" &&
  resource.serverId === source.serverId &&
  resource.locator === source.skillId;

/** Selection is session-local; registry defaults and original files are never mutated here. */
export function selectSessionSkill(
  session: CompositionSession,
  effective: CompositionResource[],
  source: SkillSelection,
  enabled: boolean,
  resourceId: string,
): Pick<CompositionSession, "resources" | "disabledResourceIds"> {
  const disabled = new Set(session.disabledResourceIds ?? []);
  const own = session.resources.filter((resource) => matches(resource, source));
  const active = effective.filter((resource) => matches(resource, source));
  if (enabled) {
    for (const resource of own) disabled.delete(resource.id);
    const resources = [...session.resources];
    if (!own.length && !active.length)
      resources.push({
        id: resourceId,
        kind: "skill",
        format: "path",
        label: source.skillId,
        serverId: source.serverId,
        connection: source.connection,
        locator: source.skillId,
        readOnly: true,
      });
    return { resources, disabledResourceIds: [...disabled] };
  }
  for (const resource of active) {
    if (!own.some((entry) => entry.id === resource.id)) disabled.add(resource.id);
  }
  for (const resource of own) disabled.delete(resource.id);
  return {
    resources: session.resources.filter((resource) => !matches(resource, source)),
    disabledResourceIds: [...disabled],
  };
}
