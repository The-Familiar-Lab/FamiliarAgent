const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync, mkdirSync, realpathSync } = require("node:fs");
const path = require("node:path");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function runtimeWorkspaces(repository) {
  const root = readJson(path.join(repository, "package.json"));
  const available = new Map(
    root.workspaces.map((directory) => {
      const manifest = readJson(path.join(repository, directory, "package.json"));
      return [manifest.name, { directory, manifest }];
    }),
  );
  const selected = new Map();
  const pending = ["@getpaseo/cli"];
  while (pending.length) {
    const name = pending.shift();
    if (selected.has(name)) continue;
    const workspace = available.get(name);
    if (!workspace) throw new Error(`Missing runtime workspace: ${name}`);
    selected.set(name, workspace);
    const dependencies = {
      ...workspace.manifest.dependencies,
      ...workspace.manifest.optionalDependencies,
    };
    for (const dependency of Object.keys(dependencies)) {
      if (available.has(dependency)) pending.push(dependency);
    }
  }
  return [...selected.values()];
}

function lockedVersion(lock, directory, name) {
  let current = directory;
  while (true) {
    const key = path.posix.join(current, "node_modules", name);
    const entry = lock.packages[key];
    if (entry?.version && !entry.link) return entry.version;
    if (!current) throw new Error(`Runtime dependency is missing from the root lock: ${name}`);
    const parent = path.posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
}

function archiveName(manifest) {
  return `${manifest.name.replace(/^@/u, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
}

function createRuntimeManifest(root, lock, workspaces) {
  const internal = new Set(workspaces.map(({ manifest }) => manifest.name));
  const overrides = structuredClone(root.overrides ?? {});
  for (const { directory, manifest } of workspaces) {
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
    const pins = {};
    for (const name of Object.keys(dependencies)) {
      if (internal.has(name)) continue;
      const version = lockedVersion(lock, directory, name);
      if (!/^\d+\.\d+\.\d+/u.test(version))
        throw new Error(`Unsupported runtime dependency version: ${name}@${version}`);
      // npm parent overrides also affect descendants; preserve unrelated major versions.
      pins[`${name}@${dependencies[name]}`] = version;
    }
    const existing = overrides[manifest.name];
    overrides[manifest.name] = { ...(typeof existing === "object" ? existing : {}), ...pins };
  }
  return {
    name: "familiaragent-runtime",
    version: root.version,
    private: true,
    familiarRuntime: { schemaVersion: 1 },
    dependencies: Object.fromEntries(
      workspaces.map(({ manifest }) => [
        manifest.name,
        `file:workspace-packages/${archiveName(manifest)}`,
      ]),
    ),
    overrides,
  };
}

function verifyRuntimeLock(manifest, lock) {
  for (const [name, source] of Object.entries(manifest.dependencies)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (entry?.resolved !== source || !entry.integrity)
      throw new Error(`Runtime lock must pin the bundled workspace archive: ${name}`);
  }
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (location && !location.startsWith("node_modules/"))
      throw new Error(`Runtime lock contains a nonportable location: ${location}`);
    const name = location.split("node_modules/").at(-1);
    if (name in manifest.dependencies && entry.resolved !== manifest.dependencies[name])
      throw new Error(`Runtime lock fetched a different internal workspace: ${location}`);
  }
}

function buildRuntimeDependencies(repository, destination) {
  // npm 10 emits escaping lockfile paths when --prefix uses macOS /var symlinks.
  destination = realpathSync(destination);
  const workspaces = runtimeWorkspaces(repository);
  const manifest = createRuntimeManifest(
    readJson(path.join(repository, "package.json")),
    readJson(path.join(repository, "package-lock.json")),
    workspaces,
  );
  const packageDirectory = path.join(destination, "workspace-packages");
  mkdirSync(packageDirectory, { recursive: true });
  for (const workspace of workspaces) {
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--workspace",
        workspace.directory,
        "--pack-destination",
        packageDirectory,
      ],
      { cwd: repository, timeout: 120_000, stdio: "pipe" },
    );
  }
  writeFileSync(path.join(destination, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      destination,
      "--workspaces=false",
      "--package-lock-only",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--fetch-retries=1",
      "--fetch-timeout=60000",
    ],
    { cwd: destination, timeout: 600_000, stdio: "pipe" },
  );
  verifyRuntimeLock(manifest, readJson(path.join(destination, "package-lock.json")));
}

module.exports = {
  runtimeWorkspaces,
  createRuntimeManifest,
  verifyRuntimeLock,
  buildRuntimeDependencies,
};
