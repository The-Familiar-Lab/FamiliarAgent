import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import path from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  bindComposition,
  createComposition,
  forkComposition,
  listComposition,
  readComposition,
  readCompositionContext,
  readCompositionProject,
  readCompositionResource,
  readCompositionSource,
  saveCompositionProject,
  updateComposition,
  ensureCompositionBridge,
  installCompositionBridge,
  compositionRuntime,
  locateCompositionResource,
} from "../../shared/composition.js";
import { forwardWorkspace } from "../authority.js";
import type { HistoryStore } from "../history/store.js";
import {
  boundedSourceRead,
  captureHistoryBoundaries,
  localResourceReader,
  routedResourceReader,
} from "./readers.js";
import { CompositionStore } from "./store.js";
import { BridgeRegistry, CompositionBridges } from "./bridge.js";
import type { CatalogInvoke } from "./catalog.js";
import { localCliReader } from "./local-reader.js";

export function registerComposition(
  server: PluginServerContext,
  options: {
    directory: string;
    home: string;
    serverId: string;
    history: HistoryStore;
    authority: () => Promise<string>;
    cliPath?: string;
  },
) {
  const store = new CompositionStore(options.directory);
  const bridgeRegistry = new BridgeRegistry(
    path.join(options.directory, "bridges"),
    options.serverId,
  );
  const bridges = new CompositionBridges({
    ...options,
    leasesDirectory: path.join(options.directory, "outgoing-bridges"),
  });
  // Source-side catalog requests never follow another private link, preventing proxy cycles.
  const catalogInvoke: CatalogInvoke = async (method, input, explicitAuthority) => {
    const id = typeof input.id === "string" ? input.id : "";
    const authority = store.hasSession(id)
      ? ""
      : (explicitAuthority ?? (await options.authority()));
    if (authority) return forwardWorkspace(authority, method, input, options.cliPath);
    switch (method) {
      case readComposition.name: {
        const request = readComposition.input.parse(input);
        return store.read(request.id, request.revision);
      }
      case readCompositionContext.name:
        return store.context(readCompositionContext.input.parse(input));
      case locateCompositionResource.name: {
        const request = locateCompositionResource.input.parse(input);
        return store.locateResource(request.id, request.resourceId, request.revision);
      }
      case updateComposition.name:
        return store.update(updateComposition.input.parse(input));
      default:
        throw new Error("Unsupported linked session action");
    }
  };
  void bridges
    .restore(
      routedResourceReader({ ...options, local: localCliReader(options.cliPath, options.home) }),
      catalogInvoke,
    )
    .then((result) => {
      if (result.failed)
        console.warn(
          `FamiliarAgent: ${result.failed} context connection(s) need reconnecting in the Hub`,
        );
      return result;
    })
    .catch(() =>
      console.warn(
        "FamiliarAgent: saved context connections could not be restored; reconnect in the Hub",
      ),
    );
  const sessionInvoke = async (method: string, input: Record<string, unknown>) => {
    const id = String(input.id);
    if (!store.hasSession(id)) {
      const linked = await bridgeRegistry.catalog(id);
      if (linked) return linked(method, input);
    }
    return catalogInvoke(method, input);
  };
  const handle = <I extends z.ZodType, O extends z.ZodType>(
    contract: PluginRpcContract<I, O>,
    local: (input: z.output<I>) => z.input<O>,
  ) =>
    server.handle(contract, async (input) => {
      const authority = await options.authority();
      return authority
        ? (contract.output.parse(
            await forwardWorkspace(
              authority,
              contract.name,
              input as Record<string, unknown>,
              options.cliPath,
            ),
          ) as z.input<O>)
        : local(input);
    });
  handle(listComposition, (input) => store.list(input));
  handle(saveCompositionProject, (input) => store.saveProject(input));
  handle(readCompositionProject, (input) => store.readProject(input.id));
  handle(createComposition, (input) => store.create(input));
  server.handle(readComposition, async (input) =>
    readComposition.output.parse(await sessionInvoke(readComposition.name, input)),
  );
  server.handle(updateComposition, async (input) =>
    updateComposition.output.parse(await sessionInvoke(updateComposition.name, input)),
  );
  handle(bindComposition, (input) => store.bind(input));
  server.handle(forkComposition, async (input, { paseo }) => {
    const authority = await options.authority();
    if (authority)
      return forkComposition.output.parse(
        await forwardWorkspace(authority, forkComposition.name, input, options.cliPath),
      );
    const replay = store.replayFork(input);
    if (replay) return replay;
    const local = localResourceReader({ ...options, paseo });
    const reader = routedResourceReader({
      ...options,
      local,
      bridge: (resource) => bridgeRegistry.reader(resource),
    });
    const boundaries = await captureHistoryBoundaries(store.forkReferences(input), reader);
    return store.fork(input, boundaries);
  });
  server.handle(readCompositionContext, async (input) =>
    readCompositionContext.output.parse(await sessionInvoke(readCompositionContext.name, input)),
  );
  server.handle(locateCompositionResource, async (input) =>
    locateCompositionResource.output.parse(
      await sessionInvoke(locateCompositionResource.name, input),
    ),
  );
  server.handle(readCompositionResource, async (input, { paseo }) => {
    const resource = locateCompositionResource.output.parse(
      await sessionInvoke(locateCompositionResource.name, {
        id: input.id,
        revision: input.revision,
        resourceId: input.resourceId,
        forwarded: input.forwarded,
      }),
    );
    const local = localResourceReader({ ...options, paseo });
    return boundedSourceRead(
      resource,
      input,
      routedResourceReader({
        ...options,
        local,
        bridge: (reference) => bridgeRegistry.reader(reference),
      }),
    );
  });
  // This route deliberately stays on the selected reader host, even if its catalog is remote.
  server.handle(readCompositionSource, async ({ resource, ...input }, { paseo }) => {
    const local = localResourceReader({ ...options, paseo });
    return boundedSourceRead(
      resource,
      input,
      routedResourceReader({
        ...options,
        local,
        bridge: (reference) => bridgeRegistry.reader(reference),
      }),
    );
  });
  server.handle(ensureCompositionBridge, (input, { paseo }) =>
    bridges.ensure(
      input,
      routedResourceReader({ ...options, local: localResourceReader({ ...options, paseo }) }),
      catalogInvoke,
    ),
  );
  server.handle(installCompositionBridge, async ({ forwarded: _forwarded, ...credential }) => {
    await bridgeRegistry.install(credential);
    return { installed: true as const };
  });
  server.handle(compositionRuntime, async ({ sessionId }) => {
    if (!options.cliPath || !path.isAbsolute(options.cliPath))
      throw new Error("FamiliarAgent CLI is not configured on this server");
    await access(options.cliPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    readComposition.output.parse(await sessionInvoke(readComposition.name, { id: sessionId }));
    return {
      mcpServers: {
        familiar_context: {
          type: "stdio" as const,
          command: options.cliPath,
          args: ["context", "mcp", "--home", options.home, "--session", sessionId],
          env: { PASEO_HOME: options.home },
        },
      },
    };
  });
  return () => {
    bridges.close();
    store.close();
  };
}
