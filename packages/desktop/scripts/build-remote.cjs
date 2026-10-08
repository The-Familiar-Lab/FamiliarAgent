const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } = require("node:fs");
const path = require("node:path");
const directory = path.resolve(__dirname, "../assets/familiar");
async function main() {
  const { pathToFileURL } = require("node:url");
  const { compilePlugin } = await import(
    pathToFileURL(path.resolve(__dirname, "../../server/dist/server/server/plugins/compiler.js"))
      .href
  );
  const { builtinPlugins } = await import(
    pathToFileURL(
      path.resolve(__dirname, "../../server/dist/server/server/plugins/builtin/index.js"),
    ).href
  );
  for (const id of builtinPlugins) {
    const root = path.resolve(__dirname, "../../server/dist/server/builtin-plugins", id);
    const server = path.join(root, "index.server.ts");
    const client = path.join(root, "index.client.tsx");
    const bundles = await compilePlugin({ server, client: existsSync(client) ? client : null });
    writeFileSync(path.join(root, "compiled.json"), JSON.stringify(bundles));
  }
  mkdirSync(directory, { recursive: true });
  const { build } = require("esbuild");
  const discordBundle = await build({
    entryPoints: [
      path.resolve(
        __dirname,
        "../../../integrations/discord-connector/apps/discord-bot/src/familiarEntry.ts",
      ),
    ],
    outfile: path.join(directory, "discord.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["bufferutil", "utf-8-validate"],
    minify: true,
    metafile: true,
  });
  writeDiscordNotices(discordBundle.metafile);
  const archive = path.join(directory, "runtime.tgz");
  execFileSync(
    "tar",
    [
      ...(process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : []),
      "-czf",
      archive,
      "--exclude=*.map",
      "-C",
      path.resolve(__dirname, "../.."),
      "server/dist",
      "cli/dist",
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  writeFileSync(
    path.join(directory, "runtime.sha256"),
    createHash("sha256").update(readFileSync(archive)).digest("hex") + "\n",
  );
}
function writeDiscordNotices(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let current = path.dirname(path.resolve(input));
    while (current !== path.dirname(current)) {
      const manifest = path.join(current, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name && pkg.version) {
          packages.set(`${pkg.name}@${pkg.version}`, { root: current, pkg });
          break;
        }
      }
      current = path.dirname(current);
    }
  }
  const notices = ["Third-party components bundled into the FamiliarAgent Discord bridge."];
  const missing = [];
  for (const [name, { root, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const files = readdirSync(root).filter((file) => /^(licen[cs]e|notice)(\..*)?$/iu.test(file));
    const supplement = path.join(
      __dirname,
      "third-party-licenses",
      `${name.replaceAll("/", "_")}.txt`,
    );
    if (!files.length && !existsSync(supplement)) missing.push(name);
    if (!files.length && existsSync(supplement)) notices.push(readFileSync(supplement, "utf8"));
    notices.push(`\n${name}\nLicense: ${pkg.license ?? "See notice below"}`);
    for (const file of files) notices.push(readFileSync(path.join(root, file), "utf8"));
  }
  if (missing.length)
    throw new Error(`No license notice found for bundled dependencies: ${missing.join(", ")}`);
  writeFileSync(path.join(directory, "THIRD-PARTY-DISCORD.txt"), notices.join("\n\n") + "\n");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
