import type { PluginHostSummary } from "@getpaseo/plugin/client";
import {
  listResources,
  saveResources,
  useHttpResource,
  crossHostHttpMcp,
  type ResourceDocument,
} from "../../shared/tool-catalog.js";
import { hostRpc } from "../fleet.js";

export interface HostResources {
  serverId: string;
  label: string;
  value?: ResourceDocument;
  error?: string;
}
export async function readResourceCatalog(
  hosts: readonly PluginHostSummary[],
  read: (serverId: string) => Promise<ResourceDocument> = (serverId) =>
    hostRpc(serverId, listResources, {}),
): Promise<HostResources[]> {
  return Promise.all(
    hosts.map(async (server): Promise<HostResources> => {
      const owner = { serverId: server.serverId, label: server.label };
      if (server.status !== "online") return { ...owner, error: "Disconnected" };
      try {
        return { ...owner, value: await read(server.serverId) };
      } catch (error) {
        return { ...owner, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

export async function shareHttpWithHosts(
  entry: import("zod").infer<typeof import("../../shared/tool-catalog.js").sharedHttpMcp>,
  hosts: readonly PluginHostSummary[],
  read: (serverId: string) => Promise<ResourceDocument> = (serverId) =>
    hostRpc(serverId, listResources, {}),
  apply: (
    serverId: string,
    expectedRevision: number,
    value: typeof entry,
  ) => Promise<{ status: "added" | "unchanged" }> = (serverId, expectedRevision, value) =>
    hostRpc(serverId, useHttpResource, { expectedRevision, entry: value }),
): Promise<string[]> {
  const value = crossHostHttpMcp.parse(entry);
  return Promise.all(
    hosts.map(async (server) => {
      if (server.status !== "online") return `${server.label}: Disconnected`;
      try {
        const current = await read(server.serverId);
        const result = await apply(server.serverId, current.revision, value);
        return `${server.label}: ${result.status === "added" ? "Added" : "Already configured"}`;
      } catch (error) {
        return `${server.label}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }),
  );
}

export async function mapSkillOnHost(
  serverId: string,
  skill: ResourceDocument["skills"][number],
  read: (serverId: string) => Promise<ResourceDocument> = (owner) =>
    hostRpc(owner, listResources, {}),
  save: (serverId: string, value: ResourceDocument) => Promise<ResourceDocument> = (owner, value) =>
    hostRpc(owner, saveResources, value),
): Promise<"added" | "unchanged"> {
  const current = await read(serverId);
  const existing = current.skills.find((item) => item.id === skill.id);
  if (existing) {
    if (existing.path === skill.path && existing.enabled === skill.enabled) return "unchanged";
    throw new Error(
      `Skill '${skill.id}' already has a different mapping on this server. Manage that server to edit it.`,
    );
  }
  await save(serverId, { ...current, skills: [...current.skills, skill] });
  return "added";
}
