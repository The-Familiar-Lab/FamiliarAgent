import path from "node:path";
import { readJson, writeJson } from "../tool-catalog/files.js";
import { readToolActionSettings, saveToolActionSettings } from "../../shared/tool-actions.js";
import type { ToolActionAdapter } from "./contracts.js";

export class ToolActionSettings {
  private queue = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly definitions: () => Pick<ToolActionAdapter, "id" | "actions">[],
  ) {}
  async read(raw: unknown) {
    const input = readToolActionSettings.input.parse(raw);
    return readToolActionSettings.output.parse(
      (await readJson(this.file(input))) ?? { parameters: {} },
    );
  }
  async save(raw: unknown) {
    const input = saveToolActionSettings.input.parse(raw);
    const definition = this.definitions()
      .find((item) => item.id === input.toolId)
      ?.actions.find((item) => item.id === input.action);
    if (!definition) throw new Error("Unknown native tool action");
    for (const key of Object.keys(input.parameters))
      if (!definition.parameters?.some((parameter) => parameter.key === key))
        throw new Error(`Unknown native setting: ${key}`);
    if (Buffer.byteLength(JSON.stringify(input.parameters)) > 16384)
      throw new Error("Saved native settings exceed 16 KiB");
    const next = this.queue.then(() =>
      writeJson(this.file(input), { parameters: input.parameters }),
    );
    this.queue = next.catch(() => {});
    await next;
    return { parameters: input.parameters };
  }
  private file(input: { toolId: string; action: string }) {
    return path.join(this.root, `${input.toolId}.${input.action}.json`);
  }
}
