import { updateToolHost } from "./catalog.js";
import { readWithDeadline } from "../read-deadline.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getPaseoClient, useHosts, type PluginSurfaceProps } from "@getpaseo/plugin/client";
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
  type CompositionEndpoint,
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
import {
  resolveSetupConfiguration,
  assertExistingSetupOptions,
  setupInstructions,
  batchSetupInstructions,
  type SetupAgentChoice,
} from "./setup.js";
import { readResourceCatalog, type HostResources } from "./resources.js";
import { readSetupWorkspace } from "../../shared/tool-setup.js";
import { readHistory } from "../../shared/history.js";
import { findNativeSession, CATALOG_PAGE_SIZE, forkWorktree } from "./entry.js";
import { prepareOriginalView } from "./original-view.js";
import type { SessionChoice } from "./browse.js";
import {
  TABS,
  readSetupReturn,
  saveSetupReturn,
  consumeSetupReturn,
  discardSetupReturn,
  type SetupReturn,
} from "./setup-return.js";
export { TABS } from "./setup-return.js";
type Tab = (typeof TABS)[number];
type Model = NonNullable<PaseoProviderModelsResult["models"]>[number];
export interface HubProps extends PluginSurfaceProps {
  Advanced: ComponentType<PluginSurfaceProps>;
  params?: Record<string, string>;
}
export interface NativeTargetSelection {
  serverId: string;
  cwd: string;
  title: string;
  provider: string;
  modelId: string;
  thinking: string;
  toolId: string;
}
function forkTitle(draft: string, parent: string): string {
  const title = draft.trim();
  return title && title !== parent ? title : `${parent} fork`;
}
function updateFleetHost(items: FleetSnapshot[], value: FleetSnapshot) {
  return [...items.filter((item) => item.server.serverId !== value.server.serverId), value];
}
const withoutServer = (items: string[], id: string) => items.filter((item) => item !== id);

export function useHubController(props: HubProps) {
  const { host: entryHost, theme, navigation } = props;
  const hosts = useHosts();
  const latestHosts = useRef(hosts);
  latestHosts.current = hosts;
  const [catalogHostId] = useState(
    () =>
      hosts.find((item) => item.isLocal && item.status === "online")?.serverId ??
      hosts.find((item) => item.isLocal)?.serverId ??
      entryHost.id,
  );
  const restoreVersion = useRef(0);
  const selectionVersion = useRef(0);
  const pendingSetupReturn = useRef<SetupReturn | null>(null);
  const cancelSetupRestore = useCallback(() => {
    restoreVersion.current++;
    try {
      const saved = pendingSetupReturn.current ?? readSetupReturn(catalogHostId);
      if (saved) consumeSetupReturn(catalogHostId, saved.id);
    } catch {
      discardSetupReturn(catalogHostId);
    } finally {
      pendingSetupReturn.current = null;
    }
  }, [catalogHostId]);
  const navigate =
    <T>(setter: Dispatch<SetStateAction<T>>) =>
    (value: SetStateAction<T>) => {
      cancelSetupRestore();
      selectionVersion.current++;
      setter(value);
    };
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
  const pendingTool = useRef<{
    serverId: string;
    toolId: string;
    sourceServer: string;
    sourceAgent: string;
  } | null>(null);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [entryChoice, setEntryChoice] = useState<SessionChoice | null>(null);
  const [target, setTarget] = useState(props.params?.serverId ?? entryHost.id),
    [cwd, setCwd] = useState(""),
    [title, setTitle] = useState("");
  const selectTarget = useCallback(
    (serverId: string) => {
      cancelSetupRestore();
      if (serverId === target) return;
      setTarget(serverId);
      setCwd(
        project?.resources.find((item) => item.kind === "codebase" && item.serverId === serverId)
          ?.locator ?? "",
      );
    },
    [project, target, cancelSetupRestore],
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
  const [pendingLaunch, setPendingLaunch] = useState<{
    sessionId: string;
    endpoint: Omit<CompositionEndpoint, "id" | "createdAt">;
    open: () => Promise<void>;
  } | null>(null);
  const [toolSettingsVersions, setToolSettingsVersions] = useState<Record<string, number>>({});
  const updatedToolSettings = useCallback((serverId: string, id: string) => {
    const key = `${serverId}:${id}`;
    setToolSettingsVersions((versions) => ({ ...versions, [key]: (versions[key] ?? 0) + 1 }));
  }, []);
  const [setupTarget, setSetupTarget] = useState<{
    serverId: string;
    toolId: string;
    returnTab?: Tab;
    intent?: "ask";
  } | null>(null);
  const openSetup = (serverId: string, selectedToolId: string, intent?: "ask") => {
    selectTarget(serverId);
    setToolId(selectedToolId);
    setSetupTarget({ serverId, toolId: selectedToolId, returnTab: tab, intent });
  };
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
  const explicitEntry = Boolean(
    props.params?.agentId ||
    props.params?.terminalId ||
    props.params?.toolId ||
    (props.params?.historyServerId && props.params?.historyId),
  );
  const catalogOnline = hosts.some((item) => item.serverId === host.id && item.status === "online");
  useEffect(() => {
    if (explicitEntry || !catalogOnline) return;
    let current = true;
    const generation = restoreVersion.current;
    const restore = async () => {
      const saved = readSetupReturn(host.id);
      if (!saved) return;
      pendingSetupReturn.current = saved;
      if (!latestHosts.current.some((item) => item.serverId === saved.target))
        throw new Error(
          "The setup return server is no longer configured. Choose a server to continue.",
        );
      const logical = saved.sessionId
        ? await hostRpc(host.id, readComposition, { id: saved.sessionId })
        : null;
      if (logical && logical.projectId !== saved.projectId)
        throw new Error("The saved session no longer belongs to this project. Select it again.");
      const owner = saved.projectId
        ? await hostRpc(host.id, readCompositionProject, { id: saved.projectId })
        : null;
      if (!current || generation !== restoreVersion.current) return;
      setProject(owner);
      setSession(logical);
      setMemory(logical?.memory ?? owner?.memory ?? "");
      setTitle(saved.title);
      setTarget(saved.target);
      setToolId(saved.toolId);
      setCwd(saved.cwd);
      setTab(saved.tab);
      consumeSetupReturn(host.id, saved.id);
      pendingSetupReturn.current = null;
      setNotice("Returned to your project and session after tool setup.");
    };
    void restore().catch((value) => {
      if (current && generation === restoreVersion.current) fail(value);
    });
    return () => {
      current = false;
    };
  }, [host.id, catalogOnline, explicitEntry, fail]);
  const rememberSetupReturn = (serverId: string, selectedToolId: string) => {
    saveSetupReturn(host.id, {
      projectId: project?.id ?? null,
      sessionId: session?.id ?? null,
      target: serverId,
      toolId: selectedToolId,
      cwd,
      title,
      tab: setupTarget?.returnTab ?? tab,
    });
  };
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
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setRefreshing(true);
    await Promise.allSettled([
      readFleet(hosts, (value) => {
        if (generation === refreshGeneration.current)
          setFleet((items) => updateFleetHost(items, value));
      }).then((value) => {
        if (generation === refreshGeneration.current) setFleet(value);
        return undefined;
      }),
      readWithDeadline(
        hostRpc(host.id, listComposition, {
          limit: CATALOG_PAGE_SIZE,
          offset: catalogOffset,
          query: catalogQuery,
        }),
        "Shared session catalog",
      )
        .then((catalog) => {
          if (generation !== refreshGeneration.current) return;
          setProjects(catalog.projects);
          setSessions(catalog.sessions);
          setCatalogTotal(catalog.total);
          setCatalogLoaded(true);
          return undefined;
        })
        .catch((value: unknown) => {
          if (generation === refreshGeneration.current) fail(value);
        }),
    ]);
    if (generation === refreshGeneration.current) setRefreshing(false);
  }, [host.id, hosts, catalogOffset, catalogQuery, fail]);
  useEffect(() => {
    const counter = refreshGeneration;
    void refresh().catch(fail);
    return () => {
      counter.current++;
    };
  }, [refresh, fail]);
  const toolReads = useRef(new Map<string, number>());
  const [toolCatalogErrors, setToolCatalogErrors] = useState<Record<string, string>>({});
  const [loadingToolServers, setLoadingToolServers] = useState<string[]>([]);
  const reloadTools = useCallback(
    async (serverId?: string) => {
      await Promise.all(
        hosts
          .filter(
            (server) => server.status === "online" && (!serverId || server.serverId === serverId),
          )
          .map(async (server) => {
            const id = server.serverId;
            const version = (toolReads.current.get(id) ?? 0) + 1;
            toolReads.current.set(id, version);
            setLoadingToolServers((items) => [...new Set([...items, id])]);
            setToolCatalogErrors((items) => ({ ...items, [id]: "" }));
            try {
              const result = await readWithDeadline(
                hostRpc(id, listTools, {}),
                `${server.label} tool catalog`,
              );
              if (toolReads.current.get(id) !== version) return;
              setTools((items) => updateToolHost(items, id, result));
            } catch (value) {
              if (toolReads.current.get(id) === version)
                setToolCatalogErrors((items) => ({
                  ...items,
                  [id]: value instanceof Error ? value.message : String(value),
                }));
            } finally {
              if (toolReads.current.get(id) === version)
                setLoadingToolServers((items) => withoutServer(items, id));
            }
          }),
      );
    },
    [hosts],
  );
  useEffect(() => {
    const reads = toolReads.current;
    void reloadTools();
    return () => {
      for (const [id, version] of reads) reads.set(id, version + 1);
    };
  }, [reloadTools]);
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
    const version = ++selectionVersion.current;
    cancelSetupRestore();
    const value = await hostRpc(host.id, readCompositionProject, { id });
    if (version !== selectionVersion.current) return;
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
      cancelSetupRestore();
      const version = ++selectionVersion.current;
      const value = await hostRpc(host.id, readComposition, { id });
      const owner = await hostRpc(host.id, readCompositionProject, {
        id: value.projectId,
      });
      if (version !== selectionVersion.current) return false;
      setEntryChoice(null);
      setProject(owner);
      setCatalogOffset(0);
      setSession(value);
      setMemory(value.memory);
      setTitle(value.title);
      setTab("Sessions");
      const endpoint = value.endpoints.find((item) => item.id === value.activeEndpointId);
      const destination = hosts.find((item) => item.serverId === endpoint?.serverId);
      if (endpoint) {
        setTarget(endpoint.serverId);
        setCwd(endpoint.cwd);
        setToolId(endpoint.harness ?? endpoint.provider);
      }
      await connectContextSources(host.id, value, destination, hosts);
      return version === selectionVersion.current;
    },
    [host.id, hosts, cancelSetupRestore],
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
  const completeNativeChoice = useCallback(
    (serverId: string, agent: PaseoAgent, owner?: CompositionProject) => {
      const requested = pendingTool.current;
      const handoff =
        requested?.sourceServer === serverId && requested.sourceAgent === agent.id
          ? requested
          : null;
      pendingTool.current = null;
      setEntryChoice(null);
      const id = handoff?.toolId ?? agent.provider;
      const destination = handoff?.serverId ?? serverId;
      const native = tools.find((item) => item.serverId === destination && item.tool.id === id)
        ?.tool.nativeProvider;
      setToolId(id);
      setTarget(destination);
      setTab(handoff && !native ? "Tools" : "Sessions");
      setCwd(
        destination === serverId
          ? agent.cwd
          : (owner?.resources.find(
              (item) => item.kind === "codebase" && item.serverId === destination,
            )?.locator ?? ""),
      );
    },
    [tools],
  );
  const attachNative = useCallback(
    async (serverId: string, agent: PaseoAgent) => {
      const existing = await findNativeSession(serverId, agent.id, (input) =>
        hostRpc(host.id, listComposition, input),
      );
      if (existing) {
        if (await selectSession(existing.id)) completeNativeChoice(serverId, agent);
        return;
      }
      const currentProject =
        (project?.resources.some(
          (resource) =>
            resource.kind === "codebase" &&
            resource.serverId === serverId &&
            resource.locator === agent.cwd,
        )
          ? project
          : null) ??
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
      completeNativeChoice(serverId, agent, currentProject);
      setProject(currentProject);
      setCatalogOffset(0);
      setMemory(created.memory);
      setSession(created);
      setTitle(created.title);
      await refresh();
      await renewLinkedSession(created);
      setNotice("Linked to the original session. Its conversation was not copied.");
    },
    [
      project,
      host.id,
      hosts,
      hostName,
      refresh,
      selectSession,
      renewLinkedSession,
      completeNativeChoice,
    ],
  );
  const linkCreatedWorkspace = async (
    owner: CompositionProject,
    directory: string,
    selection: NativeTargetSelection,
  ) => {
    if (
      owner.resources.some(
        (item) =>
          item.kind === "codebase" &&
          item.serverId === selection.serverId &&
          item.locator === directory,
      )
    )
      return;
    const next = await hostRpc(host.id, saveCompositionProject, {
      id: owner.id,
      title: owner.title,
      memory: owner.memory,
      resources: [
        ...owner.resources,
        {
          id: operationId(),
          kind: "codebase",
          label: `${hostName(selection.serverId)} project folder`,
          serverId: selection.serverId,
          connection: hosts.find((item) => item.serverId === selection.serverId)?.connection,
          format: "path",
          locator: directory,
          readOnly: true,
        },
      ],
      expectedRevision: owner.revision,
      operationId: operationId(),
    });
    setProject(next);
  };
  const bindCreatedAgent = async (
    owner: CompositionProject,
    logical: CompositionSession,
    handle: PaseoAgentHandle,
    selection: NativeTargetSelection,
  ) => {
    let next: CompositionSession;
    try {
      const createdCwd = handle.cwd;
      if (!createdCwd) throw new Error("The created agent did not report its project folder.");
      await linkCreatedWorkspace(owner, createdCwd, selection);
      setCwd(createdCwd);
      next = await hostRpc(host.id, bindComposition, {
        id: logical.id,
        expectedRevision: logical.revision,
        operationId: operationId(),
        endpoint: {
          kind: "agent",
          serverId: selection.serverId,
          connection: hosts.find((item) => item.serverId === selection.serverId)?.connection,
          agentId: handle.id,
          provider: selection.provider,
          model: selection.modelId,
          cwd: createdCwd,
          harness: selection.toolId,
        },
      });
      setSession(next);
    } catch (value) {
      throw new Error(
        `Agent ${handle.id} was created on ${hostName(selection.serverId)}, but could not be linked: ${
          value instanceof Error ? value.message : String(value)
        }. Use Link session to recover it.`,
        { cause: value },
      );
    }
    await renewLinkedSession(next);
    return next;
  };
  const logicalForLaunch = async (owner: CompositionProject, serverId: string, fork: boolean) => {
    const destination = hosts.find((item) => item.serverId === serverId);
    if (session && destination) await connectContextSources(host.id, session, destination, hosts);
    let logical: CompositionSession;
    if (session && fork)
      logical = await hostRpc(host.id, forkComposition, {
        id: session.id,
        expectedRevision: session.revision,
        title: forkTitle(title, session.title),
        operationId: operationId(),
      });
    else
      logical =
        session ??
        (await hostRpc(host.id, createComposition, {
          projectId: owner.id,
          title: title.trim() || owner.title,
          operationId: operationId(),
        }));
    setSession(logical);
    if (fork) setTitle(logical.title);
    if (destination) await connectContextSources(host.id, logical, destination, hosts);
    return logical;
  };
  const start = async (fork: boolean) => {
    if (!selectedTool?.nativeProvider || !modelId)
      throw new Error("Choose an available native agent and model.");
    if (!navigation?.openAgent) throw new Error("This view cannot open native conversations.");
    const owner = await ensureProject();
    if (
      !owner.resources.some(
        (item) => item.kind === "codebase" && item.serverId === target && item.locator === cwd,
      )
    )
      throw new Error(
        "Link this server's existing project folder first. A session fork does not copy project files.",
      );
    const logical = await logicalForLaunch(owner, target, fork);
    const { handle } = await createNativeTarget(owner, logical, { fork });
    await refresh();
    navigation.openAgent({ serverId: target, agentId: handle.id });
  };
  const nativeTargetSelection = (): NativeTargetSelection => {
    if (!selectedTool?.nativeProvider || !modelId)
      throw new Error("Choose an available native agent and model.");
    return {
      serverId: target,
      cwd,
      title,
      provider: selectedTool.nativeProvider,
      modelId,
      thinking,
      toolId,
    };
  };
  const createNativeTarget = async (
    owner: CompositionProject,
    logical: CompositionSession,
    options: {
      fork?: boolean;
      resultInput?: boolean;
      idempotencyKey?: string;
      selection?: NativeTargetSelection;
    } = {},
  ) => {
    const selection = options.selection ?? nativeTargetSelection();
    if (!selection.cwd.trim()) throw new Error("Choose the target project folder.");
    const destination = hosts.find((item) => item.serverId === selection.serverId);
    if (destination) await connectContextSources(host.id, logical, destination, hosts);
    const continuation = options.resultInput
      ? `Shared session ${logical.id}. The user will send a specifically selected source response as input. Other histories remain available through the shared tools.`
      : await continuationContext(host.id, logical, hosts);
    const runtime = await hostRpc(selection.serverId, compositionRuntime, {
      sessionId: logical.id,
    });
    const handle = await getPaseoClient(selection.serverId).agents.create({
      cwd: selection.cwd,
      title: options.fork ? logical.title : selection.title.trim() || logical.title,
      config: {
        provider: `${selection.provider}/${selection.modelId}`,
        thinkingOptionId: selection.thinking || undefined,
        systemPrompt: `${continuation}\n\nUse familiar_context and familiar_history MCP tools for shared memory and additional history. Save important decisions with familiar_memory.`,
        mcpServers: runtime.mcpServers,
      },
      worktree: options.fork && separateWorktree ? forkWorktree(operationId()) : undefined,
      labels: { familiarProject: owner.id, familiarSession: logical.id },
      idempotencyKey: options.idempotencyKey ?? operationId(),
    });
    const next = await bindCreatedAgent(owner, logical, handle, selection);
    return { session: next, handle };
  };
  const prepareExternalContext = async (serverId: string, fork: boolean) => {
    const owner = await ensureProject();
    if (
      !owner.resources.some(
        (item) => item.kind === "codebase" && item.serverId === serverId && item.locator === cwd,
      )
    )
      throw new Error("Link this server's existing project folder first.");
    const logical = await logicalForLaunch(owner, serverId, fork);
    const context = await continuationContext(host.id, logical, hosts);
    const saved = await hostRpc(serverId, writeToolContext, {
      sessionId: logical.id,
      text: context,
    });
    return { logical, contextPath: saved.path };
  };
  const finishExternalLaunch = async (pending: NonNullable<typeof pendingLaunch>) => {
    const current = await hostRpc(host.id, readComposition, { id: pending.sessionId });
    const linked = current.endpoints.find(
      (item) =>
        item.serverId === pending.endpoint.serverId &&
        item.kind === pending.endpoint.kind &&
        item.agentId === pending.endpoint.agentId,
    );
    const next = linked
      ? current
      : await hostRpc(host.id, bindComposition, {
          id: current.id,
          expectedRevision: current.revision,
          operationId: operationId(),
          endpoint: pending.endpoint,
        });
    setSession(next);
    setPendingLaunch(null);
    await refresh();
    await renewLinkedSession(next);
    await pending.open();
  };
  const recoverLaunch = async () => {
    if (!pendingLaunch || pendingLaunch.sessionId !== session?.id)
      throw new Error("Select the session that owns this original tool before linking it.");
    await finishExternalLaunch(pendingLaunch);
  };
  const showToolActions = (serverId: string, id: string, directory: string) => {
    setTarget(serverId);
    setCwd(directory);
    setToolId(id);
    setTab("Tools");
  };
  const launch = async (
    serverId: string,
    tool: ToolEntry,
    action: "launch" | "install",
    surface?: "web" | "desktop" | "terminal",
    options: { fork?: boolean } = {},
  ) => {
    if (pendingLaunch && pendingLaunch.sessionId === session?.id)
      throw new Error(
        "Retry linking the existing original interface before starting another launch.",
      );
    if (!cwd) throw new Error("Choose the destination project folder first.");
    const destination = hosts.find((item) => item.serverId === serverId);
    if (destination?.status !== "online")
      throw new Error("Reconnect this server before opening its original tool.");
    const { logical, contextPath } =
      action === "launch"
        ? await prepareExternalContext(serverId, options.fork === true)
        : { logical: null, contextPath: undefined };
    if (action === "launch" && !surface && tool.launchSurface === "actions") {
      showToolActions(serverId, tool.id, cwd);
      setNotice("Choose an original action below. No task has been started.");
      return;
    }
    const plan = await hostRpc(serverId, prepareTool, {
      id: tool.id,
      action,
      cwd,
      surface,
      contextPath,
      sessionId: action === "launch" ? logical?.id : undefined,
    });
    const view = await prepareOriginalView({ serverId, tool, plan, navigation });
    if (logical && action === "launch") {
      const pending = {
        sessionId: logical.id,
        endpoint: {
          ...view.endpoint,
          serverId,
          connection: destination.connection,
          provider: tool.id,
          harness: tool.id,
        },
        open: view.open,
      };
      setPendingLaunch(pending);
      try {
        await finishExternalLaunch(pending);
      } catch (value) {
        throw new Error(
          `The original interface was created. Its task completion is not confirmed. If linking failed, use Retry linking original; if linked, use Open original. ${value instanceof Error ? value.message : String(value)}`,
          { cause: value },
        );
      }
    } else await view.open();
    setNotice(
      [
        ...(plan.mode === "desktop"
          ? [
              "Original app launch requested. Follow Session activity or View launcher for its status; task progress remains in the original app.",
            ]
          : []),
        ...plan.notes,
      ].join("\n"),
    );
  };
  const openEndpoint = async (endpoint: Pick<CompositionEndpoint, "id">, logicalId: string) => {
    const logical = await hostRpc(host.id, readComposition, { id: logicalId });
    const original = logical.endpoints.find((item) => item.id === endpoint.id);
    if (!original)
      throw new Error("This original interface is no longer linked. Refresh the session.");
    const destination = hosts.find((item) => item.serverId === original.serverId);
    if (destination?.status !== "online")
      throw new Error("Reconnect this server before opening its original tool.");
    await connectContextSources(host.id, logical, destination, hosts);
    if (original.kind === "tool") {
      setSession(logical);
      showToolActions(original.serverId, original.provider, original.cwd);
      return;
    }
    if (original.kind === "agent") {
      if (!navigation?.openAgent) throw new Error("This view cannot open native conversations.");
      navigation.openAgent({ serverId: original.serverId, agentId: original.agentId });
      return;
    }
    if (original.kind === "desktop" || original.kind === "web") {
      if (pendingLaunch?.sessionId === logical.id)
        throw new Error(
          "Retry linking the existing original interface before starting another launch.",
        );
      const available = await hostRpc(original.serverId, listTools, {});
      const tool = available.find((item) => item.id === (original.harness ?? original.provider));
      if (!tool) throw new Error("This tool is no longer in the server catalog. Check its setup.");
      const plan = await hostRpc(original.serverId, prepareTool, {
        id: tool.id,
        action: "launch",
        cwd: original.cwd,
        sessionId: logical.id,
        surface: original.kind,
      });
      const view = await prepareOriginalView({
        serverId: original.serverId,
        tool,
        plan,
        navigation,
      });
      const pending = {
        sessionId: logical.id,
        endpoint: {
          ...view.endpoint,
          serverId: original.serverId,
          connection: destination.connection,
          provider: tool.id,
          harness: tool.id,
        },
        open: view.open,
      };
      setPendingLaunch(pending);
      await finishExternalLaunch(pending);
      return;
    }
    if (!original.workspaceId || !navigation?.openTerminal)
      throw new Error(
        "The original terminal cannot be opened from this view. Check its setup to launch again.",
      );
    navigation.openTerminal({
      serverId: original.serverId,
      workspaceId: original.workspaceId,
      terminalId: original.agentId,
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
            memoryEnabled: session.memoryEnabled,
            disabledResourceIds: session.disabledResourceIds,
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
  const [terminalEntryFailure, setTerminalEntryFailure] = useState<string | null>(null);
  useEffect(() => {
    const params = props.params;
    if (!catalogOnline || !params?.terminalId || params.agentId) return;
    const serverId = params.serverId ?? entryHost.id;
    const terminalId = params.terminalId;
    const key = JSON.stringify(["terminal", host.id, serverId, terminalId, params.cwd]);
    if (entryKey.current === key || terminalEntryFailure === key) return;
    entryKey.current = key;
    setTerminalEntryFailure(null);
    const version = restoreVersion.current;
    const resolveEntry = async () => {
      const existing = await findNativeSession(serverId, terminalId, (input) =>
        hostRpc(host.id, listComposition, input),
      );
      if (entryKey.current !== key || version !== restoreVersion.current) return;
      if (existing) {
        if (!(await selectSession(existing.id)) || entryKey.current !== key) return;
        const origin = existing.endpoints.find(
          (item) => item.serverId === serverId && item.agentId === terminalId,
        );
        if (origin) {
          setTarget(serverId);
          setCwd(origin.cwd);
          setToolId(origin.harness ?? origin.provider);
        }
      } else {
        setProject(null);
        setSession(null);
        setEntryChoice(null);
        setMemory("");
        setTitle("");
        setTarget(serverId);
        setCwd(params.cwd ?? "");
        setTab("Sessions");
        setNotice(
          "This terminal is not linked to a shared session yet. Choose or create a session in its project folder.",
        );
      }
    };
    void run(async () => {
      try {
        await resolveEntry();
      } catch (value) {
        if (entryKey.current !== key) return;
        entryKey.current = null;
        setTerminalEntryFailure(key);
        throw value;
      }
    });
  }, [
    props.params,
    catalogOnline,
    entryHost.id,
    host.id,
    run,
    selectSession,
    terminalEntryFailure,
  ]);
  useEffect(() => {
    const params = props.params;
    if (!catalogOnline || (!params?.agentId && !(params?.historyServerId && params?.historyId)))
      return;
    const key = JSON.stringify([
      entryHost.id,
      host.id,
      params.agentId,
      params.serverId,
      params.toolId,
      params.setup,
      params.historyServerId,
      params.historyId,
    ]);
    if (entryKey.current === key) return;
    entryKey.current = key;
    const entryVersion = restoreVersion.current;
    void run(async () => {
      if (params.historyServerId && params.historyId) {
        const source = await hostRpc(params.historyServerId, readHistory, {
          id: params.historyId,
          offset: 0,
          limit: 1,
        });
        await linkHistory(params.historyServerId, source);
      } else if (params.agentId) {
        const sourceServer = params.serverId ?? entryHost.id;
        const existing = await findNativeSession(sourceServer, params.agentId, (input) =>
          hostRpc(host.id, listComposition, input),
        );
        if (entryKey.current !== key || entryVersion !== restoreVersion.current) return;
        if (existing) {
          const applied = await selectSession(existing.id);
          if (!applied || entryKey.current !== key) return;
          const origin = existing.endpoints.find(
            (endpoint) => endpoint.serverId === sourceServer && endpoint.agentId === params.agentId,
          );
          if (origin) {
            setTarget(sourceServer);
            setCwd(origin.cwd);
            setToolId(origin.harness ?? origin.provider);
          }
        } else {
          const result = await getPaseoClient(sourceServer).agents.ref(params.agentId).refresh();
          if (entryKey.current !== key || entryVersion !== restoreVersion.current) return;
          if (!result) throw new Error("This native conversation is no longer available.");
          setSession(null);
          setProject(null);
          setEntryChoice({ kind: "native", serverId: sourceServer, agent: result.agent });
          setTarget(sourceServer);
          setCwd(result.agent.cwd);
          setTitle(result.agent.title || "Untitled conversation");
          setToolId(result.agent.provider);
          setTab("Sessions");
        }
      }
      if (params.toolId) {
        const serverId = params.serverId ?? entryHost.id;
        setTarget(serverId);
        setToolId(params.toolId);
        if (params.setup === "1")
          setSetupTarget({ serverId, toolId: params.toolId, returnTab: "Sessions" });
      }
    });
  }, [props.params, host.id, entryHost.id, catalogOnline, run, linkHistory, selectSession]);
  useEffect(() => {
    const params = props.params;
    if (!params?.toolId || params.agentId || params.terminalId) return;
    const key = JSON.stringify([params.serverId, params.toolId, params.setup, params.cwd]);
    if (entryKey.current === key) return;
    entryKey.current = key;
    const serverId = params.serverId ?? entryHost.id;
    setTarget(serverId);
    setToolId(params.toolId);
    if (params.cwd) setCwd(params.cwd);
    if (params.setup === "1")
      setSetupTarget({ serverId, toolId: params.toolId, returnTab: "Sessions" });
  }, [props.params, entryHost.id]);
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
        memoryEnabled: session.memoryEnabled,
        disabledResourceIds: session.disabledResourceIds,
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
  const saveSessionPreferences = async (
    next: Pick<CompositionSession, "resources" | "disabledResourceIds" | "memoryEnabled">,
  ) => {
    if (!session) throw new Error("Select a session first.");
    const version = selectionVersion.current;
    const saved = await hostRpc(host.id, updateComposition, {
      id: session.id,
      expectedRevision: session.revision,
      operationId: operationId(),
      title: session.title,
      memory: session.memory,
      ...next,
    });
    if (version === selectionVersion.current) setSession(saved);
    await renewLinkedSession(saved);
    await refresh();
    return saved;
  };
  const useSetupTool = (serverId: string, id: string, returnTab?: Tab) => {
    selectTarget(serverId);
    setToolId(id);
    setSetupTarget(null);
    if (!session && entryChoice?.kind === "native") {
      pendingTool.current = {
        serverId,
        toolId: id,
        sourceServer: entryChoice.serverId,
        sourceAgent: entryChoice.agent.id,
      };
      setTab("Sessions");
      setNotice(
        "Preview your current conversation, then Select session to continue it with the chosen tool.",
      );
      return;
    }
    const native = tools.find((item) => item.serverId === serverId && item.tool.id === id)?.tool
      .nativeProvider;
    const destination = native ? "Sessions" : "Tools";
    setTab(returnTab === "Inputs / Results" ? returnTab : destination);
    setNotice(
      `Tool selected on ${hostName(serverId)}. Choose a native action or continue the session. Link this server's project folder if needed.`,
    );
  };
  const askSetup = async (serverId: string, tool: ToolEntry, choice?: SetupAgentChoice) => {
    if (!hosts.some((item) => item.serverId === serverId && item.status === "online"))
      throw new Error("Reconnect the selected setup server first.");
    let directory = choice?.cwd ?? (target === serverId ? cwd : "");
    const batch = choice?.tools;
    if (batch && (!batch.length || batch.length > 64 || new Set(batch).size !== batch.length))
      throw new Error("Choose a nonempty, unique list of tools from this server's catalog.");
    const selectedTools = batch?.map((id) => {
      const selectedToolEntry = tools.find(
        (item) => item.serverId === serverId && item.tool.id === id,
      )?.tool;
      if (!selectedToolEntry)
        throw new Error(`Tool ${id} is not in this server's catalog. Refresh the tool list.`);
      return selectedToolEntry;
    });
    let setupOnly = false;
    const instruction = (folder: string, provider?: string) =>
      selectedTools
        ? batchSetupInstructions(selectedTools, folder, setupOnly, provider)
        : setupInstructions(tool, folder, setupOnly, provider);
    const api = getPaseoClient(serverId);
    if (choice?.agentId) {
      assertExistingSetupOptions(choice);
      const agent = api.agents.ref(choice.agentId);
      const snapshot = await agent.refresh();
      if (!snapshot) throw new Error("The selected setup agent is no longer available.");
      rememberSetupReturn(target, toolId);
      await agent.send(instruction(directory || snapshot.agent.cwd, snapshot.agent.provider), {
        activeTurnBehavior: "reject",
      });
      navigation?.openAgent({ serverId, agentId: agent.id });
    } else {
      if (!directory.trim()) {
        directory = (await hostRpc(serverId, readSetupWorkspace, {})).cwd;
        setupOnly = true;
      }
      const candidates = tools
        .filter(
          (item) =>
            item.serverId === serverId &&
            item.tool.installed &&
            item.tool.nativeProvider &&
            (!choice?.provider || item.tool.nativeProvider === choice.provider),
        )
        .map((item) => item.tool.nativeProvider!);
      const selected = await resolveSetupConfiguration(
        candidates,
        api.providers,
        directory,
        choice,
      );
      rememberSetupReturn(target, toolId);
      const agent = await api.agents.create({
        cwd: directory,
        title: selectedTools ? `Set up ${selectedTools.length} tools` : `Set up ${tool.name}`,
        config: {
          provider: `${selected.provider}/${selected.model}`,
          thinkingOptionId: selected.thinking,
          modeId: selected.modeId,
        },
        idempotencyKey: operationId(),
      });
      navigation?.openAgent({ serverId, agentId: agent.id });
      await agent.send(instruction(directory, selected.provider), { activeTurnBehavior: "reject" });
    }
    setSetupTarget(null);
    setNotice(
      `Setup requested on ${hostName(serverId)}. Follow the selected agent for progress and any required login.`,
    );
    await refresh();
  };

  return {
    host,
    entryChoice,
    catalogLoaded,
    terminalEntryFailed: terminalEntryFailure !== null,
    retryTerminalEntry: () => setTerminalEntryFailure(null),
    useSetupTool,
    theme,
    navigation,
    hosts,
    tab,
    setTab: navigate(setTab),
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
    setProject: navigate(setProject),
    session,
    setSession: navigate(setSession),
    target,
    setTarget: selectTarget,
    cwd,
    setCwd: navigate(setCwd),
    title,
    setTitle: navigate(setTitle),
    tools,
    setTools,
    reloadTools,
    toolCatalogErrors,
    loadingToolServers,
    toolId,
    setToolId: navigate(setToolId),
    setupTarget,
    setSetupTarget,
    openSetup,
    rememberSetupReturn,
    toolSettingsVersions,
    updatedToolSettings,
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
    saveSessionPreferences,
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
    refreshing,
    selectProject,
    selectSession,
    mapping,
    ensureProject,
    linkFolder,
    attachNative,
    start,
    createNativeTarget,
    nativeTargetSelection,
    launch,
    pendingLaunch,
    recoverLaunch,
    openEndpoint,
    linkHistory,
  };
}
export type HubController = ReturnType<typeof useHubController>;
