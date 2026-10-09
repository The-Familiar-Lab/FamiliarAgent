import { resolveAgentReply } from "./server/agent-reply.js";
import { nativeActionContext } from "./server/tool-actions/context.js";
import { ToolActions } from "./server/tool-actions/service.js";
import { ToolRunStore } from "./server/tool-actions/store.js";
import { NATIVE_TOOL_ADAPTERS } from "./server/native-tools/index.js";
import { INTEGRATED_TOOL_ADAPTERS } from "./server/integrated-tools/index.js";
import { INFRASTRUCTURE_ADAPTERS } from "./server/infrastructure/index.js";
import { ToolCatalog } from "./server/tool-catalog/service.js";
import { HistoryStore } from "./server/history/store.js";
import { registerComposition } from "./server/composition/register.js";
import { registerToolCatalog } from "./server/tool-catalog/index.js";
import { readFileSync } from "node:fs";
import {
  listHistory,
  scanHistory,
  readHistory,
  hideHistory,
  exportHistory,
} from "./shared/history.js";
import { forwardWorkspace } from "./server/authority.js";
import { ArtifactStore, getArtifact } from "./server/artifacts.js";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { buildProviderSetup } from "./server/provider-setup.js";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  providerSetup,
  readSpace,
  saveSpace,
  listSpaces,
  agentStatus,
  agentSend,
  agentPermission,
  artifactPut,
  artifactGet,
  sharingSettings,
  workspaceDocument,
} from "./shared/contracts.js";
import { WorkspaceStore } from "./server/store.js";

export default function contribute(server: PluginServerContext) {
  const home = process.env.PASEO_HOME;
  if (!home) throw new Error("FamiliarAgent requires an explicit PASEO_HOME for isolated storage.");
  const history = new HistoryStore(path.join(home, "familiar", "history"));
  registerToolCatalog(server, home);
  server.handle(listHistory, (input) => history.list(input));
  server.handle(scanHistory, (input) => history.start(input));
  server.handle(readHistory, ({ id, offset, limit }) => history.readPage(id, offset, limit));
  server.handle(hideHistory, ({ id, hidden }) => history.hide(id, hidden));
  server.handle(exportHistory, ({ id }) => history.export(id));
  const artifacts = new ArtifactStore(path.join(home, "familiar", "artifacts"));
  const store = new WorkspaceStore(path.join(home, "familiar", "spaces"));
  server.handle(providerSetup, async ({ provider }) => {
    const cwd = path.join(home, "familiar", "provider-setup");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    return { cwd, ...buildProviderSetup(provider) };
  });
  const sharing = server.registerSettings(sharingSettings);
  const authority = async () => {
    const settings = await sharing.read();
    if (settings.status !== "ready") throw new Error(settings.error);
    return settings.values.authority;
  };
  const serverId =
    process.env.PASEO_SERVER_ID || readFileSync(path.join(home, "server-id"), "utf8").trim();
  const toolCatalog = new ToolCatalog(home);
  const actions = new ToolActions(
    new ToolRunStore(path.join(home, "familiar", "tool-actions"), serverId),
    [...NATIVE_TOOL_ADAPTERS, ...INTEGRATED_TOOL_ADAPTERS, ...INFRASTRUCTURE_ADAPTERS],
    (command) => toolCatalog.resolveCommand(command),
    Number(process.env.FAMILIAR_TOOL_CONCURRENCY ?? 4),
    nativeActionContext(home, toolCatalog),
  );
  const stopComposition = registerComposition(server, {
    actions,
    directory: path.join(home, "familiar", "composition"),
    home,
    serverId,
    history,
    authority,
    cliPath: process.env.PASEO_CLI,
  });
  server.handle(readSpace, async (input) => {
    const host = await authority();
    return host
      ? workspaceDocument.parse(
          await forwardWorkspace(host, "space.read", input, process.env.PASEO_CLI),
        )
      : store.read(input.id);
  });
  server.handle(saveSpace, async (input) => {
    const host = await authority();
    if (host)
      return workspaceDocument.parse(
        await forwardWorkspace(host, "space.save", input, process.env.PASEO_CLI),
      );
    const { forwarded: _forwarded, ...document } = input;
    return store.save(document);
  });
  server.handle(listSpaces, async (input) => {
    const host = await authority();
    return host
      ? listSpaces.output.parse(
          await forwardWorkspace(host, "space.list", input, process.env.PASEO_CLI),
        )
      : store.list();
  });
  server.handle(agentStatus, async ({ agentId, messageId }, { paseo }) => {
    const agent = paseo.agents.ref(agentId);
    const snapshot = await agent.refresh();
    if (!snapshot) throw new Error("Agent not found");
    const timeline = await agent.timeline.refetch({
      limit: messageId ? 64 : 12,
      direction: "tail",
      projection: "canonical",
    });
    if (timeline.error) throw new Error(timeline.error);
    let assistantReply = messageId
      ? await resolveAgentReply(agent, timeline, messageId)
      : undefined;
    if (assistantReply) {
      const latest = await agent.timeline.refetch({
        limit: 1,
        direction: "tail",
        projection: "canonical",
      });
      if (
        latest.error ||
        latest.gap ||
        latest.staleCursor ||
        latest.epoch !== timeline.epoch ||
        latest.endCursor?.seq !== timeline.endCursor?.seq
      )
        assistantReply = null;
    }
    return {
      agentId,
      provider: snapshot.agent.provider,
      status: snapshot.agent.status,
      cwd: snapshot.agent.cwd,
      permissions: snapshot.agent.pendingPermissions ?? [],
      ...(messageId ? { assistantReply } : {}),
      recent: timeline.entries.flatMap(({ item }) =>
        item.type === "assistant_message" || item.type === "user_message" ? [item.text] : [],
      ),
    };
  });
  server.handle(agentSend, async ({ agentId, text, messageId }, { paseo }) => {
    await paseo.agents.ref(agentId).send(text, { messageId, activeTurnBehavior: "steer" });
    return { accepted: true as const, agentId };
  });
  server.handle(agentPermission, async ({ agentId, requestId, behavior }, { paseo }) => {
    await paseo.agents.ref(agentId).respondToPermission({ requestId, response: { behavior } });
    return { resolved: true as const };
  });
  server.handle(artifactPut, (input) => artifacts.put(input));
  server.handle(artifactGet, async ({ agentId, path: requestedPath }, { paseo }) => {
    const snapshot = await paseo.agents.ref(agentId).refresh();
    if (!snapshot) throw new Error("Agent not found");
    return getArtifact(snapshot.agent.cwd, requestedPath);
  });
  return () => {
    stopComposition();
    void actions.close();
  };
}
