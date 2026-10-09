import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PaseoAgent } from "@getpaseo/client";
import type { HubController } from "./controller.js";
import { hostRpc } from "../fleet.js";
import { readComposition, type CompositionEndpoint } from "../../shared/composition.js";

export type SessionChoice =
  | { kind: "shared"; id: string }
  | { kind: "native"; serverId: string; agent: PaseoAgent };
export const choiceKey = (choice: SessionChoice) =>
  choice.kind === "shared" ? `shared:${choice.id}` : `native:${choice.serverId}:${choice.agent.id}`;
export interface BrowseRow {
  key: string;
  choice: SessionChoice;
  title: string;
  detail: string;
  folder: string;
  projectKey: string;
  projectLabel: string;
  servers: string[];
}
export function sessionRows(
  hub: Pick<HubController, "sessions" | "projects" | "fleet" | "hostName" | "query" | "filter">,
): BrowseRow[] {
  const linked = new Set(
    hub.sessions.flatMap((session) =>
      session.endpoints
        .filter((endpoint) => !endpoint.kind || endpoint.kind === "agent")
        .map((endpoint) => `${endpoint.serverId}:${endpoint.agentId}`),
    ),
  );
  const shared: BrowseRow[] = hub.sessions.map((session) => {
    const active = session.endpoints.find((endpoint) => endpoint.id === session.activeEndpointId);
    const servers = [...new Set(session.endpoints.map((endpoint) => endpoint.serverId))];
    const choice: SessionChoice = { kind: "shared", id: session.id };
    return {
      key: choiceKey(choice),
      choice,
      title: session.title,
      detail: active
        ? `${active.harness ?? active.provider} · ${active.model ?? "Model not reported"} · ${servers.map(hub.hostName).join(", ")}`
        : "Shared session · no active tool",
      folder: active?.cwd ?? "",
      projectKey: `shared:${session.projectId}`,
      projectLabel:
        hub.projects.find((project) => project.id === session.projectId)?.title ?? "Linked project",
      servers,
    };
  });
  const native: BrowseRow[] = hub.fleet.flatMap(({ server, agents }) =>
    agents
      .filter((agent) => !linked.has(`${server.serverId}:${agent.id}`))
      .map((agent) => {
        const choice: SessionChoice = { kind: "native", serverId: server.serverId, agent };
        return {
          key: choiceKey(choice),
          choice,
          title: agent.title || "Untitled conversation",
          detail: `${agent.provider} · ${agent.model ?? "Model not reported"} · ${server.label} · ${agent.status}`,
          folder: agent.cwd,
          projectKey: `native:${server.serverId}:${agent.cwd}`,
          projectLabel: `${agent.cwd.split("/").findLast(Boolean) || "Native conversations"} · ${server.label}`,
          servers: [server.serverId],
        };
      }),
  );
  const query = hub.query.trim().toLowerCase();
  return [...shared, ...native].filter(
    (row) =>
      (hub.filter === "all" || row.servers.includes(hub.filter)) &&
      `${row.title} ${row.detail} ${row.folder} ${row.projectLabel}`.toLowerCase().includes(query),
  );
}
export function groupSessions(
  rows: BrowseRow[],
  mode: "project" | "server",
  hostName: (id: string) => string,
) {
  const groups = new Map<string, { id: string; label: string; rows: BrowseRow[] }>();
  for (const row of rows) {
    let keys = row.servers.length ? row.servers : ["unassigned"];
    if (mode === "project") keys = [row.projectKey];
    for (const id of keys) {
      const group = groups.get(id) ?? {
        id,
        label: groupLabel(mode, row, id, hostName),
        rows: [],
      };
      group.rows.push(row);
      groups.set(id, group);
    }
  }
  return [...groups.values()];
}
function groupLabel(
  mode: "project" | "server",
  row: BrowseRow,
  id: string,
  hostName: (id: string) => string,
) {
  if (mode === "project") return row.projectLabel;
  return id === "unassigned" ? "No server yet" : hostName(id);
}
export interface SessionPreview {
  title: string;
  endpoints: CompositionEndpoint[];
  messages: { id: string; role: string; text: string }[];
  note: string;
}
const PREVIEW_ITEMS = 12;
const PREVIEW_CHARACTERS = 8000;
export async function readSessionPreview(
  catalogId: string,
  choice: SessionChoice,
  online: ReadonlySet<string>,
): Promise<SessionPreview> {
  const logical =
    choice.kind === "shared" ? await hostRpc(catalogId, readComposition, { id: choice.id }) : null;
  const active = logical?.endpoints.find((item) => item.id === logical.activeEndpointId);
  const endpoint =
    choice.kind === "native"
      ? {
          id: choice.agent.id,
          kind: "agent" as const,
          serverId: choice.serverId,
          agentId: choice.agent.id,
          provider: choice.agent.provider,
          model: choice.agent.model ?? undefined,
          cwd: choice.agent.cwd,
          createdAt: "",
        }
      : active;
  const preview: SessionPreview = {
    title:
      logical?.title ??
      (choice.kind === "native" ? choice.agent.title || "Untitled conversation" : "Session"),
    endpoints: logical?.endpoints ?? (endpoint ? [endpoint] : []),
    messages: [],
    note: "",
  };
  if (!endpoint || (endpoint.kind && endpoint.kind !== "agent")) {
    preview.note =
      "This session uses an original tool surface. Select it to open that tool or continue elsewhere.";
    return preview;
  }
  if (!online.has(endpoint.serverId)) {
    preview.note = "This server is offline. Reconnect it to preview the conversation.";
    return preview;
  }
  return loadPreviewMessages(preview, endpoint);
}
async function loadPreviewMessages(
  preview: SessionPreview,
  endpoint: CompositionEndpoint,
): Promise<SessionPreview> {
  const page = await getPaseoClient(endpoint.serverId)
    .agents.ref(endpoint.agentId)
    .timeline.refetch({ direction: "tail", projection: "canonical", limit: PREVIEW_ITEMS });
  if (page.error || page.staleCursor || page.gap)
    throw new Error(page.error || "Conversation changed while loading. Preview it again.");
  let remaining = PREVIEW_CHARACTERS;
  for (const { item, seqEnd } of page.entries) {
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    if (remaining <= 0) break;
    const text = item.text.slice(0, remaining);
    remaining -= text.length;
    preview.messages.push({
      id: `${page.epoch}:${seqEnd}`,
      role: item.type === "user_message" ? "You" : "Assistant",
      text,
    });
  }
  preview.note = preview.messages.length
    ? "Conversation preview. Selecting does not send a message."
    : "No conversation messages yet.";
  if (page.hasOlder || remaining === 0)
    preview.note =
      "Recent conversation preview. Open the original conversation for the full history.";
  return preview;
}
