import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
// Its UMD entry leaves relative runtime requires outside the self-contained plugin bundle.
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  type ParseError,
} from "jsonc-parser/lib/esm/main.js";
import { directory, writeText } from "./files.js";

const EDITORS = {
  cursor: { folder: ".cursor", key: "mcpServers" },
  vscode: { folder: ".vscode", key: "servers" },
} as const;
type Editor = keyof typeof EDITORS;
interface StdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/** Insert one project-scoped server without reserializing foreign settings or credentials. */
export async function projectEditorMcp(cwd: string, editor: Editor, server: StdioServer) {
  const project = await directory(cwd);
  const format = EDITORS[editor];
  const folder = path.join(project, format.folder);
  const file = path.join(folder, "mcp.json");
  await assertFolder(folder);
  const original = await readConfig(file);
  const updated = insertServer(original ?? "{}\n", format.key, server);
  if (original === updated) return { file, status: "unchanged" as const };
  await mkdir(folder, { recursive: true });
  await assertFolder(folder);
  if ((await directory(cwd)) !== project || (await readConfig(file)) !== original)
    throw new Error("The editor MCP configuration changed. Retry after reviewing the latest file.");
  await writeText(file, updated);
  return { file, status: "added" as const };
}

async function assertFolder(folder: string) {
  try {
    const info = await lstat(folder);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(
        "The editor configuration folder must be a real project directory, not a symbolic link.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readConfig(file: string): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("The editor MCP configuration must be a regular file.");
    if (info.size > MAX_CONFIG_BYTES)
      throw new Error("The editor MCP configuration exceeds 2 MiB.");
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function insertServer(text: string, key: string, server: StdioServer) {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== "object")
    throw new Error(
      "The existing editor MCP configuration is not a valid JSON/JSONC object. It was preserved.",
    );
  const groups = tree.children?.filter((node) => node.children?.[0]?.value === key) ?? [];
  if (groups.length > 1)
    throw new Error(
      "The editor MCP configuration has duplicate server sections. It was preserved.",
    );
  const group = findNodeAtLocation(tree, [key]);
  if (group && group.type !== "object")
    throw new Error("The editor MCP server section must be an object. It was preserved.");
  const entries =
    group?.children?.filter((node) => node.children?.[0]?.value === "familiar_context") ?? [];
  if (entries.length > 1)
    throw new Error(
      "The editor MCP configuration has duplicate familiar_context entries. It was preserved.",
    );
  const current = findNodeAtLocation(tree, [key, "familiar_context"]);
  if (current) {
    if (isDeepStrictEqual(JSON.parse(JSON.stringify(getNodeValue(current))), server)) return text;
    throw new Error(
      "This project already has a different familiar_context connection. Remove that entry in the editor's project MCP settings before linking another session; the existing configuration was preserved.",
    );
  }
  return applyEdits(
    text,
    modify(text, [key, "familiar_context"], server, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}
