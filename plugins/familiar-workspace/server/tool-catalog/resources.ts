import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { z } from "zod";
import {
  projectResources,
  resourceDocument,
  toolId,
  useHttpResource,
  useSkills,
  readSkill,
  changeSkill,
  type ResourceDocument,
} from "../../shared/tool-catalog.js";
import { directory, readJson, writeJson } from "./files.js";
import { projectEditorMcp } from "./project-mcp.js";

const SKILL_ROOTS = {
  claude: ".claude/skills",
  codex: ".agents/skills",
  cursor: ".cursor/skills",
} as const;
const manifestSchema = z
  .object({
    version: z.literal(1),
    cwd: z.string(),
    toolId: z.enum(["claude", "codex", "cursor"]),
    links: z.record(toolId, z.array(z.string()).min(1).max(2)),
  })
  .strict();
type RuntimeMcp =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string };
type ProjectionResult = z.infer<typeof projectResources.output>;

/** Host-local paths are references, never recursive skill copies. Remote hosts
 * register their own paths, including existing shared-filesystem mounts. */
export class ResourceLibrary {
  private queue = Promise.resolve();
  constructor(private readonly root: string) {}
  async list(): Promise<ResourceDocument> {
    return resourceDocument.parse(
      (await readJson(path.join(this.root, "familiar", "resources.json"))) ?? {
        revision: 0,
        skills: [],
        mcp: [],
      },
    );
  }
  async save(input: ResourceDocument): Promise<ResourceDocument> {
    const value = resourceDocument.parse(input);
    if (value.mcp.some((server) => ["paseo", "familiar_context"].includes(server.id)))
      throw new Error(
        "The paseo and familiar_context MCP names are reserved for FamiliarAgent runtime access.",
      );
    return this.mutate(async () => {
      const existing = await this.list();
      if (value.revision !== existing.revision)
        throw new Error("Shared resources changed. Refresh before saving.");
      const skills = await Promise.all(
        value.skills.map(async (skill) => {
          const source = await directory(skill.path);
          if (!(await stat(path.join(source, "SKILL.md"))).isFile())
            throw new Error(`Skill ${skill.id} has no SKILL.md file`);
          return { ...skill, path: source };
        }),
      );
      const next = { ...value, skills, revision: existing.revision + 1 };
      await writeJson(path.join(this.root, "familiar", "resources.json"), next);
      return next;
    });
  }
  async useHttp(input: z.input<typeof useHttpResource.input>) {
    const value = useHttpResource.input.parse(input);
    if (["paseo", "familiar_context"].includes(value.entry.id))
      throw new Error(
        "The paseo and familiar_context MCP names are reserved for FamiliarAgent runtime access.",
      );
    return this.mutate(async () => {
      const existing = await this.list();
      if (value.expectedRevision !== existing.revision)
        throw new Error("Shared resources changed. Refresh before applying this connection.");
      const match = existing.mcp.find((entry) => entry.id === value.entry.id);
      if (match) {
        if (
          match.type !== "http" ||
          match.url !== value.entry.url ||
          match.enabled !== value.entry.enabled
        )
          throw new Error(
            `MCP '${value.entry.id}' already has a different configuration on this server. It was preserved.`,
          );
        return { status: "unchanged" as const, resources: existing };
      }
      const next = resourceDocument.parse({
        ...existing,
        revision: existing.revision + 1,
        mcp: [...existing.mcp, value.entry],
      });
      await writeJson(path.join(this.root, "familiar", "resources.json"), next);
      return { status: "added" as const, resources: next };
    });
  }
  async useSkills(input: z.input<typeof useSkills.input>) {
    const value = useSkills.input.parse(input);
    return this.mutate(async () => {
      const current = await this.list();
      this.assertRevision(current, value.expectedRevision);
      const nextSkills = [...current.skills];
      for (const skill of value.skills) {
        const source = await directory(skill.path);
        if (!(await stat(path.join(source, "SKILL.md"))).isFile())
          throw new Error(`Skill ${skill.id} has no SKILL.md file`);
        const existing = nextSkills.find((item) => item.id === skill.id);
        if (existing) {
          if (existing.path !== source || existing.enabled !== skill.enabled)
            throw new Error(
              `Skill '${skill.id}' already has different settings. Its mapping was preserved.`,
            );
        } else nextSkills.push({ ...skill, path: source });
      }
      if (nextSkills.length === current.skills.length)
        return { status: "unchanged" as const, resources: current };
      const resources = resourceDocument.parse({
        ...current,
        revision: current.revision + 1,
        skills: nextSkills,
      });
      await writeJson(path.join(this.root, "familiar", "resources.json"), resources);
      return { status: "added" as const, resources };
    });
  }
  async changeSkill(input: z.input<typeof changeSkill.input>) {
    const value = changeSkill.input.parse(input);
    return this.mutate(async () => {
      const current = await this.list();
      this.assertRevision(current, value.expectedRevision);
      const existing = current.skills.find((item) => item.id === value.id);
      if (!existing) throw new Error("The selected skill is no longer registered on this server.");
      if (value.action !== "remove" && existing.enabled === (value.action === "enable"))
        return current;
      const skills =
        value.action === "remove"
          ? current.skills.filter((item) => item.id !== value.id)
          : current.skills.map((item) =>
              item.id === value.id ? { ...item, enabled: value.action === "enable" } : item,
            );
      const next = resourceDocument.parse({ ...current, revision: current.revision + 1, skills });
      await writeJson(path.join(this.root, "familiar", "resources.json"), next);
      return next;
    });
  }
  async readSkill(input: z.input<typeof readSkill.input>) {
    const value = readSkill.input.parse(input);
    const skill = (await this.list()).skills.find((item) => item.id === value.id);
    if (!skill) throw new Error("The selected skill is not registered on this server.");
    const folder = await directory(skill.path);
    const filePath = await realpath(path.join(folder, "SKILL.md"));
    if (!filePath.startsWith(`${folder}${path.sep}`))
      throw new Error("SKILL.md must remain inside its registered skill folder.");
    const file = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("SKILL.md must be a regular file.");
      const buffer = Buffer.alloc(value.maxCharacters * 4 + 4);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return {
        id: skill.id,
        path: filePath,
        enabled: skill.enabled,
        text: text.slice(0, value.maxCharacters),
        truncated: info.size > bytesRead || text.length > value.maxCharacters,
      };
    } finally {
      await file.close();
    }
  }
  private assertRevision(current: ResourceDocument, expected: number) {
    if (current.revision !== expected)
      throw new Error("Shared resources changed. Refresh before applying this change.");
  }
  /** For the existing before(agent.create) hook. Session-specific definitions
   * must take precedence when the caller merges them. Native credentials stay native. */
  async runtimeMcpServers(provider: string): Promise<Record<string, RuntimeMcp>> {
    if (!["claude", "codex"].includes(provider)) return {};
    return Object.fromEntries(
      (await this.list()).mcp
        .filter((server) => server.enabled)
        .map((server) => [
          server.id,
          server.type === "stdio"
            ? { type: "stdio" as const, command: server.command, args: server.args }
            : { type: "http" as const, url: server.url },
        ]),
    );
  }
  async claudeLaunchArgs(sessionId?: string): Promise<string[]> {
    const mcpServers = {
      ...(await this.runtimeMcpServers("claude")),
      ...(await this.sessionMcp(sessionId)),
    };
    if (!Object.keys(mcpServers).length) return [];
    const digest = createHash("sha256").update(JSON.stringify(mcpServers)).digest("hex");
    const file = path.join(this.root, "familiar", "resource-configs", `${digest}.json`);
    if (!(await readJson(file))) await writeJson(file, { mcpServers });
    return ["--mcp-config", file];
  }
  async codexLaunchArgs(sessionId?: string): Promise<string[]> {
    const servers = {
      ...(await this.runtimeMcpServers("codex")),
      ...(await this.sessionMcp(sessionId)),
    };
    return Object.entries(servers).flatMap(([id, server]) => {
      const prefix = `mcp_servers.${id}`;
      if (server.type === "http") return ["-c", `${prefix}.url=${JSON.stringify(server.url)}`];
      const args = [
        "-c",
        `${prefix}.command=${JSON.stringify(server.command)}`,
        "-c",
        `${prefix}.args=${JSON.stringify(server.args)}`,
      ];
      for (const [key, value] of Object.entries(server.env ?? {}))
        args.push("-c", `${prefix}.env.${key}=${JSON.stringify(value)}`);
      return args;
    });
  }
  async gooseLaunch(sessionId: string): Promise<{ args: string[]; env: Record<string, string> }> {
    const server = (await this.sessionMcp(sessionId)).familiar_context;
    if (!server || server.type !== "stdio")
      throw new Error("A selected FamiliarAgent session is required for Goose MCP access.");
    const env: Record<string, string> = {
      FAMILIAR_MCP_CLI: server.command,
      FAMILIAR_MCP_HOME: this.root,
    };
    const references = server.args.map((value, index) => {
      const key = `FAMILIAR_MCP_ARGUMENT_${index}`;
      env[key] = value;
      return `"$${key}"`;
    });
    // Goose's command parser is not a shell parser. Keep its input static;
    // quoted shell variable references preserve every argv byte without eval.
    const command = [
      "exec /usr/bin/env",
      'PASEO_HOME="$FAMILIAR_MCP_HOME"',
      '"$FAMILIAR_MCP_CLI"',
      ...references,
    ].join(" ");
    return {
      args: ["--with-extension", `familiar_context:/bin/sh -c '${command}'`],
      env,
    };
  }
  private async sessionMcp(sessionId?: string): Promise<Record<string, RuntimeMcp>> {
    if (!sessionId) return {};
    const cli = process.env.PASEO_CLI;
    if (!cli || !path.isAbsolute(cli))
      throw new Error("FamiliarAgent CLI is not configured for shared session access");
    await access(cli, constants.X_OK);
    return {
      familiar_context: {
        type: "stdio",
        command: cli,
        args: ["context", "mcp", "--home", this.root, "--session", sessionId],
        env: { PASEO_HOME: this.root },
      },
    };
  }
  async projectEditor(input: { cwd: string; toolId: "cursor" | "vscode"; sessionId: string }) {
    const server = (await this.sessionMcp(input.sessionId)).familiar_context;
    if (!server || server.type !== "stdio")
      throw new Error("A selected FamiliarAgent session is required for editor MCP access.");
    return this.mutate(() => projectEditorMcp(input.cwd, input.toolId, server));
  }
  async project(input: z.input<typeof projectResources.input>): Promise<ProjectionResult> {
    const value = projectResources.input.parse(input);
    return this.mutate(async () => {
      if (value.expectedRevision !== undefined)
        this.assertRevision(await this.list(), value.expectedRevision);
      return this.projectSkills(value);
    });
  }
  private async projectSkills(
    value: z.output<typeof projectResources.input>,
  ): Promise<ProjectionResult> {
    const cwd = await directory(value.cwd);
    const nativeRoot = path.join(cwd, SKILL_ROOTS[value.toolId]);
    const key = createHash("sha256").update(`${cwd}\0${value.toolId}`).digest("hex");
    const manifestPath = path.join(this.root, "familiar", "resource-projections", `${key}.json`);
    const manifest = manifestSchema.parse(
      (await readJson(manifestPath)) ?? { version: 1, cwd, toolId: value.toolId, links: {} },
    );
    if (manifest.cwd !== cwd || manifest.toolId !== value.toolId)
      throw new Error("Resource projection does not match the selected project");
    const result: ProjectionResult = {
      paths: [],
      unchanged: [],
      conflicts: [],
      removed: [],
      notes: [
        "Skills are symbolic links to their authoritative folders; no recursive copying. Original skill contents are never changed.",
      ],
    };
    await this.assertDirectories(cwd, nativeRoot);
    const wanted = await this.desiredSkills(nativeRoot, value.remove);
    const remove: Array<{ id: string; file: string }> = [];
    const add: Array<{ id: string; file: string; source: string }> = [];
    const managed = { ...manifest.links };
    for (const [id, sources] of Object.entries(manifest.links)) {
      const file = path.join(nativeRoot, id);
      const info = await this.info(file);
      if (!info) delete managed[id];
      else if (info.isSymbolicLink() && sources.includes(await this.linkTarget(file))) {
        if (wanted.get(id) !== (await this.linkTarget(file))) remove.push({ id, file });
      } else result.conflicts.push(`${file}: changed outside FamiliarAgent; preserved`);
    }
    for (const [id, source] of wanted) {
      const file = path.join(nativeRoot, id);
      const info = await this.info(file);
      if (!info) add.push({ id, file, source });
      else if (info.isSymbolicLink() && (await this.linkTarget(file)) === source)
        result.unchanged.push(file);
      else if (remove.some((item) => item.id === id)) add.push({ id, file, source });
      else result.conflicts.push(`${file}: already exists; preserved`);
    }
    if (result.conflicts.length) return result;
    // Persist intent first so interrupted linking can be retried and reversed.
    const intended = { ...managed };
    for (const item of add)
      intended[item.id] = [...new Set([...(intended[item.id] ?? []), item.source])];
    await writeJson(manifestPath, { ...manifest, links: intended });
    for (const item of remove) {
      await rm(item.file);
      result.removed.push(item.file);
    }
    if (add.length) await mkdir(nativeRoot, { recursive: true });
    for (const item of add) {
      await symlink(item.source, item.file, "dir");
      result.paths.push(item.file);
    }
    const settled = Object.fromEntries(
      Object.keys(intended).flatMap((id) => (wanted.has(id) ? [[id, [wanted.get(id)!]]] : [])),
    );
    await writeJson(manifestPath, { ...manifest, links: settled });
    return result;
  }
  private async desiredSkills(nativeRoot: string, remove: boolean): Promise<Map<string, string>> {
    const desired = remove ? [] : (await this.list()).skills.filter((skill) => skill.enabled);
    const wanted = new Map<string, string>();
    for (const skill of desired) {
      const source = await directory(skill.path);
      if (!(await stat(path.join(source, "SKILL.md"))).isFile())
        throw new Error(`Skill ${skill.id} no longer contains SKILL.md`);
      if (
        source === nativeRoot ||
        source.startsWith(`${nativeRoot}${path.sep}`) ||
        nativeRoot.startsWith(`${source}${path.sep}`)
      )
        throw new Error("A skill source cannot be inside its own projection folder");
      wanted.set(skill.id, source);
    }
    return wanted;
  }
  private async info(file: string) {
    try {
      return await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async linkTarget(file: string): Promise<string> {
    const target = path.resolve(path.dirname(file), await readlink(file));
    try {
      return await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw error;
    }
  }
  private async assertDirectories(cwd: string, target: string): Promise<void> {
    let current = cwd;
    for (const part of path.relative(cwd, target).split(path.sep)) {
      current = path.join(current, part);
      const info = await this.info(current);
      if (info?.isSymbolicLink())
        throw new Error(`Refusing to project through a symbolic link: ${current}`);
      if (info && !info.isDirectory())
        throw new Error(`Projection parent is not a directory: ${current}`);
    }
    if ((await realpath(cwd)) !== cwd)
      throw new Error("The project directory changed during projection");
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
