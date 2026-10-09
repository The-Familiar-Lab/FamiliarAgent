import { readToolActionSettings, saveToolActionSettings } from "../../shared/tool-actions.js";
import type { ToolActionSettings } from "./settings.js";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ToolActions } from "./service.js";
import {
  listToolActions,
  startToolAction,
  readToolRun,
  listToolRuns,
  cancelToolRun,
  resolveToolRun,
} from "../../shared/tool-actions.js";
import { captureToolRunResult } from "../../shared/results.js";
import { captureToolResult } from "./results.js";

export function registerToolActions(
  server: PluginServerContext,
  actions: ToolActions,
  requireSession: (id: string) => Promise<unknown>,
  settings?: ToolActionSettings,
) {
  if (settings) {
    server.handle(readToolActionSettings, (input) => settings.read(input));
    server.handle(saveToolActionSettings, (input) => settings.save(input));
  }
  server.handle(listToolActions, () => actions.definitions());
  server.handle(startToolAction, async (input) => {
    await requireSession(input.sessionId);
    return actions.start(input);
  });
  server.handle(readToolRun, ({ id }) => actions.store.read(id));
  server.handle(cancelToolRun, ({ id }) => actions.cancel(id));
  server.handle(resolveToolRun, (input) => actions.resolve(input));
  server.handle(listToolRuns, ({ sessionId, offset, limit }) =>
    actions.store.list(sessionId, offset, limit),
  );
  server.handle(captureToolRunResult, ({ id }) => captureToolResult(actions.store, id));
}
