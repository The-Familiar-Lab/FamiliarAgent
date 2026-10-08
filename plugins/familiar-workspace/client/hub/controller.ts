import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import {
  getPaseoClient,
  openExternalUrl,
  useHosts,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import type { PaseoAgent, PaseoAgentHandle, PaseoProviderModelsResult } from "@getpaseo/client";
import {
  bindComposition,
  createComposition,
  forkComposition,
  listComposition,
  readComposition,
  readCompositionProject,
  saveCompositionProject,
  updateComposition,
  type CompositionProject,
  type CompositionSession,
  compositionRuntime,
  type CompositionResource,
  compositionProjectSummary,
  compositionSessionSummary,
} from "../../shared/composition.js";
import {
  listTools,
  prepareTool,
  saveResources,
  writeToolContext,
  type ToolEntry,
  type ResourceDocument,
} from "../../shared/tool-catalog.js";
import {
  hostRpc,
  readFleet,
  operationId,
  continuationContext,
  connectContextSources,
  type FleetSnapshot,
} from "../fleet.js";
import type { infer as Infer } from "zod";
import { resolveSetupModel, setupInstructions } from "./setup.js";
import { readResourceCatalog, type HostResources } from "./resources.js";
import { readHistory } from "../../shared/history.js";
import { findNativeSession, CATALOG_PAGE_SIZE, forkWorktree } from "./entry.js";
export const TABS = [
  "Projects",
  "Sessions",
  "Tools",
  "Memory & Skills",
  "Files",
  "Servers",
  "History",
] as const;
type Tab = (typeof TABS)[number];
type Model = NonNullable<PaseoProviderModelsResult["models"]>[number];
export interface HubProps extends PluginSurfaceProps {
  Advanced: ComponentType<PluginSurfaceProps>;
  params?: Record<string, string>;
}
function forkTitle(draft: string, parent: string): string {
  const title = draft.trim();
  return title && title !== parent ? title : `${parent} fork`;
}
export function useHubController(props: HubProps) {
  const { host: entryHost, theme, navigation } = props;
  const hosts = useHosts();
  const [catalogHostId] = useState(
    () =>
      hosts.find((item) => item.isLocal && item.status === "online")?.serverId ??
      hosts.find((item) => item.isLocal)?.serverId ??
      entryHost.id,
  );
  const host = {
    id: catalogHostId,
    label: hosts.find((item) => item.serverId === catalogHostId)?.label ?? catalogHostId,
  };
  const [tab, setTab] = useState<Tab>("Projects"),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState("");
  const [fleet, setFleet] = useState<FleetSnapshot[]>([]),
    [projects, setProjects] = useState<Infer<typeof compositionProjectSummary>[]>([]),
    [sessions, setSessions] = useState<Infer<typeof compositionSessionSummary>[]>([]);
  const [project, setProject] = useState<CompositionProject | null>(null),
    [session, setSession] = useState<CompositionSession | null>(null);
  const [target, setTarget] = useState(entryHost.id),
    [cwd, setCwd] = useState(""),
    [title, setTitle] = useState("");
  const selectTarget = useCallback(
    (serverId: string) => {
      if (serverId === target) return;
      setTarget(serverId);
      setCwd(
        project?.resources.find((item) => item.kind === "codebase" && item.serverId === serverId)
          ?.locator ?? "",
      );
    },
    [project, target],
  );
  const [tools, setTools] = useState<
      {
        serverId: string;
        tool: ToolEntry;
      }[]
    >([]),
    [toolId, setToolId] = useState("codex"),
    [models, setModels] = useState<Model[]>([]),
    [modelId, setModelId] = useState(""),
    [thinking, setThinking] = useState("");
  const [memory, setMemory] = useState("");
  const [separateWorktree, setSeparateWorktree] = useState(false);
  const [resourceCatalog, setResourceCatalog] = useState<HostResources[]>([]);
  const resources = resourceCatalog.find((item) => item.serverId === target)?.value ?? null;
  const [catalogOffset, setCatalogOffset] = useState(0),
    [catalogTotal, setCatalogTotal] = useState(0),
    [catalogQuery, setCatalogQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setCatalogQuery(query);
      setCatalogOffset(0);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  const [skillName, setSkillName] = useState(""),
    [skillPath, setSkillPath] = useState(""),
    [mcpName, setMcpName] = useState(""),
    [mcpUrl, setMcpUrl] = useState("");
  const [customName, setCustomName] = useState(""),
    [customUrl, setCustomUrl] = useState(""),
    [customCommand, setCustomCommand] = useState(""),
    [customArgs, setCustomArgs] = useState("[]");
  const [advanced, setAdvanced] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const fail = useCallback(
    (value: unknown) => setError(value instanceof Error ? value.message : String(value)),
    [],
  );
  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await action();
      } catch (value) {
        fail(value);
      } finally {
        setBusy(false);
      }
    },
    [fail],
  );
  const hostName = useCallback(
    (id: string) => hosts.find((item) => item.serverId === id)?.label ?? id,
    [hosts],
  );
  const visible = fleet.filter((item) => filter === "all" || item.server.serverId === filter);
  const online = hosts.filter((item) => item.status === "online");
  const targetHost = hosts.find((item) => item.serverId === target);
  const selectedTool = tools.find(
    (item) => item.serverId === target && item.tool.id === toolId,
  )?.tool;
  const refreshGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const [native, shared] = await Promise.allSettled([
      readFleet(hosts),
      hostRpc(host.id, listComposition, {
        limit: CATALOG_PAGE_SIZE,
        offset: catalogOffset,
        query: catalogQuery,
        projectId: project?.id,
      }),
    ]);
    if (generation !== refreshGeneration.current) return;
    if (native.status === "fulfilled") setFleet(native.value);
    else fail(native.reason);
    if (shared.status === "rejected") {
      fail(shared.reason);
      return;
    }
    const catalog = shared.value;
    // List summaries stay bounded; only selected records carry the actual memory and resources.
    setProjects(catalog.projects);
    setSessions(catalog.sessions);
    setCatalogTotal(catalog.total);
  }, [host.id, hosts, catalogOffset, catalogQuery, project?.id, fail]);
  useEffect(() => {
    void refresh().catch(fail);
  }, [refresh, fail]);
  useEffect(() => {
    let current = true;
    void Promise.all(
      hosts
        .filter((item) => item.status === "online")
        .map(async (server) => {
          try {
            return (await hostRpc(server.serverId, listTools, {})).map((tool) => ({
              serverId: server.serverId,
              tool,
            }));
          } catch (value) {
            if (current) fail(value);
            return [];
          }
        }),
    ).then((items) => {
      if (current) setTools(items.flat());
      return undefined;
    });
    return () => {
      current = false;
    };
  }, [hosts, fail]);
  useEffect(() => {
    let current = true;
    setModels([]);
    setModelId("");
    setThinking("");
    const provider = selectedTool?.nativeProvider;
    if (provider) {
      void Promise.resolve()
        .then(() =>
          getPaseoClient(target).providers.listModels(provider, {
            cwd: cwd || undefined,
          }),
        )
        .then((result) => {
          if (!current) return;
          if (result.error) throw new Error(result.error);
          const choices = (result.models ?? []).filter((item) => item.isSelectable !== false);
          setModels(choices);
          const first = choices.find((item) => item.isDefault) ?? choices[0];
          setModelId(first?.id ?? "");
          setThinking(first?.defaultThinkingOptionId ?? "");
          return undefined;
        })
        .catch((value) => {
          if (current) fail(value);
        });
    }
    return () => {
      current = false;
    };
  }, [selectedTool?.nativeProvider, target, cwd, fail]);
  const resourcesGeneration = useRef(0);
  const reloadResources = useCallback(async () => {
    const generation = ++resourcesGeneration.current;
    const result = await readResourceCatalog(hosts);
    if (generation === resourcesGeneration.current) setResourceCatalog(result);
  }, [hosts]);
  useEffect(() => {
    setResourceCatalog([]);
    if (tab === "Memory & Skills") void reloadResources().catch(fail);
    return () => {
      resourcesGeneration.current += 1;
    };
  }, [reloadResources, tab, fail]);
  const saveOwnedResources = async (value: ResourceDocument) => {
    if (!resources || value.revision !== resources.revision)
      throw new Error("Reload this server's resources before saving.");
    const owner = target;
    const next = await hostRpc(owner, saveResources, value);
    setResourceCatalog((items) =>
      items.map((item) => (item.serverId === owner ? { ...item, value: next } : item)),
    );
  };
  const selectProject = async (id: string) => {
    const value = await hostRpc(host.id, readCompositionProject, { id });
    setProject(value);
    setCatalogOffset(0);
    setSession(null);
    setMemory(value.memory);
    const mapping = value.resources.find(
      (item) => item.kind === "codebase" && item.serverId === target,
    );
    if (mapping) setCwd(mapping.locator);
  };
  const selectSession = useCallback(
    async (id: string) => {
      const value = await hostRpc(host.id, readComposition, { id });
      const owner = await hostRpc(host.id, readCompositionProject, {
        id: value.projectId,
      });
      setProject(owner);
      setCatalogOffset(0);
      setSession(value);
      setMemory(value.memory);
      setTitle(value.title);
      setTab("Sessions");
      const endpoint = value.endpoints.find((item) => item.id === value.activeEndpointId);
      const destination = hosts.find((item) => item.serverId === endpoint?.serverId);
      await connectContextSources(host.id, value, destination, hosts);
      if (endpoint) {
        setTarget(endpoint.serverId);
        setCwd(endpoint.cwd);
        setToolId(endpoint.harness ?? endpoint.provider);
      }
    },
    [host.id, hosts],
  );
  const mapping = (): CompositionResource => ({
    id: operationId(),
    kind: "codebase",
    label: `${hostName(target)} project folder`,
    serverId: target,
    connection: targetHost?.connection,
    format: "path",
    locator: cwd,
    readOnly: true,
  });
  const ensureProject = async () => {
    if (project) return project;
    if (!cwd.trim()) throw new Error("Choose a project folder first.");
    await getPaseoClient(target).workspaces.open({ cwd });
    const next = await hostRpc(host.id, saveCompositionProject, {
      id: operationId(),
      title: title.trim() || cwd.split("/").findLast(Boolean) || "Project",
      memory: "",
      resources: [mapping()],
      expectedRevision: 0,
      operationId: operationId(),
    });
    setProject(next);
    await refresh();
    return next;
  };
  const linkFolder = async () => {
    if (!project) {
      await ensureProject();
      return;
    }
    await getPaseoClient(target).workspaces.open({ cwd });
    if (
      project.resources.some(
        (item) => item.kind === "codebase" && item.serverId === target && item.locator === cwd,
      )
    )
      return;
    const next = await hostRpc(host.id, saveCompositionProject, {
      id: project.id,
      title: project.title,
      memory: project.memory,
      expectedRevision: project.revision,
      operationId: operationId(),
      resources: [...project.resources, mapping()],
    });
    setProject(next);
    setNotice("Folder linked. Files stay on their original server.");
    await refresh();
  };
  const renewLinkedSession = useCallback(
    async (next: CompositionSession) => {
      try {
        await connectContextSources(host.id, next, undefined, hosts);
      } catch (value) {
        throw new Error(
          `The session link was saved, but shared history connections could not be refreshed. Reconnect the affected servers and reopen this session to retry. ${
            value instanceof Error ? value.message : String(value)
          }`,
          { cause: value },
        );
      }
    },
    [host.id, hosts],
  );
  const attachNative = useCallback(
    async (serverId: string, agent: PaseoAgent) => {
      const existing = await findNativeSession(serverId, agent.id, (input) =>
        hostRpc(host.id, listComposition, input),
      );
      if (existing) {
        await selectSession(existing.id);
        return;
      }
      const currentProject =
        project ??
        (await hostRpc(host.id, saveCompositionProject, {
          id: operationId(),
          title: agent.cwd.split("/").findLast(Boolean) || "Project",
          memory: "",
          resources: [
            {
              id: operationId(),
              kind: "codebase",
              label: hostName(serverId),
              serverId,
              connection: hosts.find((item) => item.serverId === serverId)?.connection,
              format: "path",
              locator: agent.cwd,
              readOnly: true,
            },
          ],
          expectedRevision: 0,
          operationId: operationId(),
        }));
      const created = await hostRpc(host.id, createComposition, {
        projectId: currentProject.id,
        title: agent.title || "Session",
        operationId: operationId(),
        endpoint: {
          serverId,
          connection: hosts.find((item) => item.serverId === serverId)?.connection,
          agentId: agent.id,
          provider: agent.provider,
          model: agent.model ?? undefined,
          cwd: agent.cwd,
        },
      });
      setProject(currentProject);
      setCatalogOffset(0);
      setMemory(created.memory);
      setSession(created);
      setTitle(created.title);
      setTarget(serverId);
      setCwd(agent.cwd);
      await refresh();
      await renewLinkedSession(created);
      setNotice("Linked to the original session. Its conversation was not copied.");
    },
    [project, host.id, hosts, hostName, refresh, selectSession, renewLinkedSession],
  );
  const linkCreatedWorkspace = async (owner: CompositionProject, directory: string) => {
    if (
      owner.resources.some(
        (item) =>
          item.kind === "codebase" && item.serverId === target && item.locator === directory,
      )
    )
      return;
    const next = await hostRpc(host.id, saveCompositionProject, {
      id: owner.id,
      title: owner.title,
      memory: owner.memory,
      resources: [...owner.resources, { ...mapping(), locator: directory }],
      expectedRevision: owner.revision,
      operationId: operationId(),
    });
    setProject(next);
  };
  const bindCreatedAgent = async (
    owner: CompositionProject,
    logical: CompositionSession,
    handle: PaseoAgentHandle,
    provider: string,
  ) => {
    let next: CompositionSession;
    try {
      const createdCwd = handle.cwd;
      if (!createdCwd) throw new Error("The created agent did not report its project folder.");
      await linkCreatedWorkspace(owner, createdCwd);
      setCwd(createdCwd);
      next = await hostRpc(host.id, bindComposition, {
        id: logical.id,
        expectedRevision: logical.revision,
        operationId: operationId(),
        endpoint: {
          kind: "agent",
          serverId: target,
          connection: targetHost?.connection,
          agentId: handle.id,
          provider,
          model: modelId,
          cwd: createdCwd,
          harness: toolId,
        },
      });
      setSession(next);
    } catch (value) {
      throw new Error(
        `Agent ${handle.id} was created on ${hostName(target)}, but could not be linked: ${
          value instanceof Error ? value.message : String(value)
        }. Use Link session to recover it.`,
        { cause: value },
      );
    }
    await renewLinkedSession(next);
  };
  const start = async (fork: boolean) => {
    if (!selectedTool?.nativeProvider || !modelId)
      throw new Error("Choose an available native agent and model.");
    const owner = await ensureProject();
    if (
      !owner.resources.some(
        (item) => item.kind === "codebase" && item.serverId === target && item.locator === cwd,
      )
    )
      throw new Error(
        "Link this server's existing project folder first. A session fork does not copy project files.",
      );
    if (session && targetHost) await connectContextSources(host.id, session, targetHost, hosts);
    let logical: CompositionSession;
    if (session && fork)
      logical = await hostRpc(host.id, forkComposition, {
        id: session.id,
        expectedRevision: session.revision,
        title: forkTitle(title, session.title),
        operationId: operationId(),
      });
    else if (session) logical = session;
    else
      logical = await hostRpc(host.id, createComposition, {
        projectId: owner.id,
        title: title.trim() || owner.title,
        operationId: operationId(),
      });
    setSession(logical);
    if (fork) setTitle(logical.title);
    if (targetHost) await connectContextSources(host.id, logical, targetHost, hosts);
    const continuation = await continuationContext(host.id, logical, hosts);
    const runtime = await hostRpc(target, compositionRuntime, {
      sessionId: logical.id,
    });
    const handle = await getPaseoClient(target).agents.create({
      cwd,
      title: fork ? logical.title : title.trim() || logical.title,
      config: {
        provider: `${selectedTool.nativeProvider}/${modelId}`,
        thinkingOptionId: thinking || undefined,
        systemPrompt: `${continuation}\n\nUse familiar_context and familiar_history MCP tools for shared memory and additional history. Save important decisions with familiar_memory.`,
        mcpServers: runtime.mcpServers,
      },
      worktree: fork && separateWorktree ? forkWorktree(operationId()) : undefined,
      labels: { familiarProject: owner.id, familiarSession: logical.id },
      idempotencyKey: operationId(),
    });
    await bindCreatedAgent(owner, logical, handle, selectedTool.nativeProvider);
    await refresh();
    navigation?.openAgent({ serverId: target, agentId: handle.id });
  };
  const prepareExternalContext = async (serverId: string) => {
    const destination = hosts.find((item) => item.serverId === serverId);

    const owner = await ensureProject();
    if (
      !owner.resources.some(
        (item) => item.kind === "codebase" && item.serverId === serverId && item.locator === cwd,
      )
    )
      throw new Error("Link this server's existing project folder first.");
    const logical =
      session ??
      (await hostRpc(host.id, createComposition, {
        projectId: owner.id,
        title: title.trim() || owner.title,
        operationId: operationId(),
      }));
    setSession(logical);
    if (destination) await connectContextSources(host.id, logical, destination, hosts);
    const context = await continuationContext(host.id, logical, hosts);
    const saved = await hostRpc(serverId, writeToolContext, {
      sessionId: logical.id,
      text: context,
    });
    return { logical, contextPath: saved.path };
  };
  const launch = async (
    serverId: string,
    tool: ToolEntry,
    action: "launch" | "install",
    surface?: "web" | "desktop" | "terminal",
  ) => {
    if (!cwd) throw new Error("Choose the destination project folder first.");
    const destination = hosts.find((item) => item.serverId === serverId);
    const { logical, contextPath } =
      action === "launch"
        ? await prepareExternalContext(serverId)
        : { logical: null, contextPath: undefined };
    const plan = await hostRpc(serverId, prepareTool, {
      id: tool.id,
      action,
      cwd,
      surface,
      contextPath,
      sessionId: action === "launch" ? logical?.id : undefined,
    });
    const api = getPaseoClient(serverId),
      workspace = await api.workspaces.open({ cwd });
    let endpoint;
    if (plan.url) {
      endpoint = { kind: "web" as const, agentId: tool.id, url: plan.url };
      if (navigation?.openBrowser)
        await navigation.openBrowser({
          url: plan.url,
          workspaceId: workspace.id,
          serverId,
        });
      else await openExternalUrl(plan.url);
    } else {
      if (!plan.command) throw new Error("The tool did not return a launch command.");
      const terminal = await api.terminals.create({
        workspaceId: workspace.id,
        cwd,
        name: `${action === "install" ? "Install " : ""}${tool.name}`,
        command: plan.command,
        args: plan.args,
      });
      endpoint = {
        kind: plan.mode === "desktop" ? ("desktop" as const) : ("terminal" as const),
        agentId: terminal.id,
      };
      navigation?.openTerminal?.({
        serverId,
        workspaceId: workspace.id,
        terminalId: terminal.id,
      });
    }
    if (logical && action === "launch") {
      const next = await hostRpc(host.id, bindComposition, {
        id: logical.id,
        expectedRevision: logical.revision,
        operationId: operationId(),
        endpoint: {
          ...endpoint,
          serverId,
          connection: destination?.connection,
          provider: tool.id,
          harness: tool.id,
          cwd,
          workspaceId: workspace.id,
        },
      });
      setSession(next);
      await refresh();
      await renewLinkedSession(next);
    }
    setNotice(
      [...plan.notes, ...(contextPath ? [`Shared context file: ${contextPath}`] : [])].join("\n"),
    );
  };
  const openEndpoint = async (
    endpoint: CompositionSession["endpoints"][number],
    logicalId: string,
  ) => {
    const logical = await hostRpc(host.id, readComposition, { id: logicalId });
    const destination = hosts.find((item) => item.serverId === endpoint.serverId);
    if (destination?.status === "online")
      await connectContextSources(host.id, logical, destination, hosts);
    if (endpoint.kind === "agent")
      navigation?.openAgent({
        serverId: endpoint.serverId,
        agentId: endpoint.agentId,
      });
    else if (endpoint.kind === "web" && endpoint.url && endpoint.workspaceId)
      await navigation?.openBrowser?.({
        serverId: endpoint.serverId,
        workspaceId: endpoint.workspaceId,
        url: endpoint.url,
      });
    else if (endpoint.workspaceId)
      navigation?.openTerminal?.({
        serverId: endpoint.serverId,
        workspaceId: endpoint.workspaceId,
        terminalId: endpoint.agentId,
      });
  };
  const linkHistory = useCallback(
    async (serverId: string, conversation: import("../../shared/history.js").HistorySummary) => {
      const owner =
        project ??
        (await hostRpc(host.id, saveCompositionProject, {
          id: operationId(),
          title: conversation.title.slice(0, 200),
          memory: "",
          resources: [],
          expectedRevision: 0,
          operationId: operationId(),
        }));
      const reference: CompositionResource = {
        id: operationId(),
        kind: "history",
        format: "imported-history",
        serverId,
        connection: hosts.find((item) => item.serverId === serverId)?.connection,
        label: `${conversation.source}: ${conversation.title}`.slice(0, 200),
        locator: conversation.id,
        readOnly: true,
      };
      const next = session
        ? await hostRpc(host.id, updateComposition, {
            id: session.id,
            expectedRevision: session.revision,
            operationId: operationId(),
            title: session.title,
            memory: session.memory,
            resources: [...session.resources, reference],
          })
        : await hostRpc(host.id, createComposition, {
            projectId: owner.id,
            title: conversation.title.slice(0, 200),
            resources: [reference],
            operationId: operationId(),
          });
      setProject(owner);
      setCatalogOffset(0);
      setMemory(next.memory);
      setSession(next);
      setTitle(next.title);
      setTab("Sessions");
      await refresh();
      await renewLinkedSession(next);
      setNotice(
        "Original history linked. Choose a project folder and Link folder to continue with another tool.",
      );
    },
    [project, session, host.id, hosts, refresh, renewLinkedSession],
  );
  const entryKey = useRef<string | null>(null);
  useEffect(() => {
    const params = props.params;
    if (!params?.agentId && !(params?.historyServerId && params?.historyId)) return;
    const key = JSON.stringify([
      entryHost.id,
      host.id,
      params.agentId,
      params.historyServerId,
      params.historyId,
    ]);
    if (entryKey.current === key) return;
    entryKey.current = key;
    void run(async () => {
      if (params.historyServerId && params.historyId) {
        const source = await hostRpc(params.historyServerId, readHistory, {
          id: params.historyId,
          offset: 0,
          limit: 1,
        });
        await linkHistory(params.historyServerId, source);
      } else if (params.agentId) {
        const existing = await findNativeSession(entryHost.id, params.agentId, (input) =>
          hostRpc(host.id, listComposition, input),
        );
        if (existing) await selectSession(existing.id);
        else {
          const result = await getPaseoClient(entryHost.id).agents.ref(params.agentId).refresh();
          if (!result) throw new Error("This native conversation is no longer available.");
          await attachNative(entryHost.id, result.agent);
          setTab("Sessions");
        }
      }
    });
  }, [props.params, host.id, entryHost.id, run, linkHistory, selectSession, attachNative]);
  const reloadMemory = async () => {
    if (session) {
      const next = await hostRpc(host.id, readComposition, { id: session.id });
      setSession(next);
      setMemory(next.memory);
    } else if (project) {
      const next = await hostRpc(host.id, readCompositionProject, {
        id: project.id,
      });
      setProject(next);
      setMemory(next.memory);
    }
    setNotice("Latest shared memory loaded. You can review it and save again.");
  };
  const saveMemory = async () => {
    if (session) {
      const next = await hostRpc(host.id, updateComposition, {
        id: session.id,
        expectedRevision: session.revision,
        operationId: operationId(),
        title: session.title,
        resources: session.resources,
        memory,
      });
      setSession(next);
    } else if (project) {
      const next = await hostRpc(host.id, saveCompositionProject, {
        id: project.id,
        title: project.title,
        resources: project.resources,
        memory,
        expectedRevision: project.revision,
        operationId: operationId(),
      });
      setProject(next);
    } else throw new Error("Select a project first.");
    setNotice(
      "Shared memory saved. Connected sessions can read it; future tool switches include it.",
    );
  };
  const askSetup = async (serverId: string, tool: ToolEntry) => {
    if (!cwd.trim() || target !== serverId)
      throw new Error("Choose this server and a project folder first.");
    const candidates = tools
      .filter(
        (item) => item.serverId === serverId && item.tool.installed && item.tool.nativeProvider,
      )
      .map((item) => item.tool.nativeProvider!);
    const api = getPaseoClient(serverId);
    const selected = await resolveSetupModel(candidates, (provider) =>
      api.providers.listModels(provider, { cwd }),
    );
    const agent = await api.agents.create({
      cwd,
      title: `Set up ${tool.name}`,
      config: {
        provider: `${selected.provider}/${selected.model}`,
        thinkingOptionId: selected.thinking,
      },
      idempotencyKey: operationId(),
    });
    navigation?.openAgent({ serverId, agentId: agent.id });
    await agent.send(setupInstructions(tool, cwd));
    setNotice(
      `Setup agent started on ${hostName(
        serverId,
      )}. Follow its conversation for progress and any required login.`,
    );
    await refresh();
  };
  return {
    host,
    theme,
    navigation,
    hosts,
    tab,
    setTab,
    filter,
    setFilter,
    query,
    setQuery,
    fleet,
    setFleet,
    projects,
    setProjects,
    sessions,
    setSessions,
    project,
    setProject,
    session,
    setSession,
    target,
    setTarget: selectTarget,
    cwd,
    setCwd,
    title,
    setTitle,
    tools,
    setTools,
    toolId,
    setToolId,
    models,
    setModels,
    modelId,
    setModelId,
    thinking,
    setThinking,
    memory,
    setMemory,
    separateWorktree,
    setSeparateWorktree,
    resources,
    resourceCatalog,
    reloadResources,
    saveOwnedResources,
    reloadMemory,
    saveMemory,
    askSetup,
    catalogOffset,
    setCatalogOffset,
    catalogTotal,
    skillName,
    setSkillName,
    skillPath,
    setSkillPath,
    mcpName,
    setMcpName,
    mcpUrl,
    setMcpUrl,
    customName,
    setCustomName,
    customUrl,
    setCustomUrl,
    customCommand,
    setCustomCommand,
    customArgs,
    setCustomArgs,
    advanced,
    setAdvanced,
    busy,
    setBusy,
    error,
    setError,
    notice,
    setNotice,
    fail,
    run,
    hostName,
    visible,
    online,
    targetHost,
    selectedTool,
    refresh,
    selectProject,
    selectSession,
    mapping,
    ensureProject,
    linkFolder,
    attachNative,
    start,
    launch,
    openEndpoint,
    linkHistory,
  };
}
export type HubController = ReturnType<typeof useHubController>;
