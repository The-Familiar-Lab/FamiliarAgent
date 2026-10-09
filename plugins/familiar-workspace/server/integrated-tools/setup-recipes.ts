import type { IntegratedInstallRecipe } from "./setup-install.js";

const sources = {
  "docker-skills": {
    version: "0.3.1-f791727",
    repository: "docker/skills",
    commit: "f79172733725e2fd236343ee7b963c446ed85d09",
    verify: ["skills.sh.json", ".claude-plugin/plugin.json", "LICENSE"],
  },
  agents: {
    version: "1.7.1",
    repository: "wshobson/agents",
    commit: "46891e7e60da0e52baf1050b7b6391b64e84c6d9",
    verify: ["plugins/python-development/.claude-plugin/plugin.json"],
  },
  codey: {
    version: "0.13.4",
    repository: "its-ahoh/codey",
    commit: "80071d138e6e65b63fff758663576d56ca2fe040",
    verify: ["packages/gateway/dist/index.js", "packages/core/dist/index.js"],
    commands: [
      {
        command: "npm",
        args: [
          "ci",
          "--workspace=@codey/core",
          "--workspace=@codey/gateway",
          "--include-workspace-root",
        ],
      },
      { command: "npm", args: ["run", "build:core"] },
      { command: "npm", args: ["run", "build:gateway"] },
    ],
  },
  hydra: {
    version: "0.2.61",
    repository: "jpdlr/hydra",
    commit: "d8ad56112c2c3acfb2f65f53b6890f30a25c693c",
    verify: ["out/main/daemon.js"],
    commands: [
      { command: "npm", args: ["ci"] },
      { command: "npm", args: ["run", "build"] },
    ],
  },
} satisfies Record<string, Omit<IntegratedInstallRecipe, "id">>;

const codegDigests: Record<string, string> = {
  "darwin-arm64": "723b43eb81ce05e805a1ed4ef4eb54dddeb58f420ee8323a0f340e625ba71e76",
  "darwin-x64": "de1c169fb4a6d96a77ac800cd1f5e7611760160e81dd24c2db7c2fcb518b6c37",
  "linux-arm64": "cd36ba81e1e857d5134253cc40c49205a4310248753d3c19d99bd07d1c485166",
  "linux-x64": "40602becfe6c4cd85e4f44c5c0edebb7694558ec6243df141dcbca428609544a",
};
const nodeDigests: Record<string, string> = {
  "darwin-arm64": "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  "darwin-x64": "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
  "linux-arm64": "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
  "linux-x64": "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
};
const aletheDigests: Record<
  string,
  { file: string; digest: string; executable: string; format: "tar" | "deb" }
> = {
  "darwin-arm64": {
    file: "Alethe_aarch64.app.tar.gz",
    digest: "b7368625969791c7564392e54186d3a98c4daf81dae1269377431222abde3755",
    executable: "Alethe.app/Contents/MacOS/alethe-orchestrator-mcp",
    format: "tar",
  },
  "darwin-x64": {
    file: "Alethe_x64.app.tar.gz",
    digest: "61db7a84908be1f65955348b0b6ebaff9c2db7f460a0da393c481c9c16efb8f6",
    executable: "Alethe.app/Contents/MacOS/alethe-orchestrator-mcp",
    format: "tar",
  },
  "linux-x64": {
    file: "Alethe_1.7.0_amd64.deb",
    digest: "a4c8a6c89387cb97dcc523696dedc7cbeaf542cf42de1bf17b045ca3e3653f7e",
    executable: "usr/bin/alethe-orchestrator-mcp",
    format: "deb",
  },
};

/** Release digests are the upstream GitHub asset SHA-256 values checked on 2026-10-09. */
export function integratedRecipe(
  id: string,
  platform: string,
  arch: string,
): IntegratedInstallRecipe | null {
  if (Object.hasOwn(sources, id)) {
    const source = sources[id as keyof typeof sources];
    if (id === "codey") {
      const target = `${platform}-${arch}`;
      const sha256 = nodeDigests[target];
      if (!sha256) return null;
      const directory = `node-v24.21.0-${target}`;
      return {
        ...source,
        id,
        version: `${source.version}-node24.21.0`,
        repository: `https://github.com/${source.repository}.git`,
        runtime: { url: `https://nodejs.org/dist/v24.21.0/${directory}.tar.gz`, sha256, directory },
        verify: [...source.verify, `.familiar-runtime/${directory}/bin/node`],
      };
    }
    return { ...source, id, repository: `https://github.com/${source.repository}.git` };
  }
  const target = `${platform}-${arch}`;
  if (id === "codeg" && codegDigests[target]) {
    const name = `codeg-server-${target}`;
    return {
      id,
      version: "0.34.0",
      url: `https://github.com/spacering-net/codeg/releases/download/v0.34.0/${name}.tar.gz`,
      sha256: codegDigests[target],
      format: "tar",
      verify: [`${name}/codeg-server`],
    };
  }
  if (id === "alethe" && aletheDigests[target]) {
    const asset = aletheDigests[target]!;
    return {
      id,
      version: "1.7.0",
      url: `https://github.com/Kc1t/alethe-agents/releases/download/v1.7.0/${asset.file}`,
      sha256: asset.digest,
      format: asset.format,
      verify: [asset.executable],
    };
  }
  if (id === "orca" && platform === "darwin" && ["arm64", "x64"].includes(arch)) {
    return {
      id,
      version: "1.4.223",
      url: `https://github.com/stablyai/orca/releases/download/v1.4.223/Orca-1.4.223-${arch === "arm64" ? "arm64-" : ""}mac.zip`,
      sha256:
        arch === "arm64"
          ? "ee88c03049c9b763c9fc2994117710efccea539d816ed8dc98bedc7463fdaa46"
          : "adf6c1d652d2a950a434e770ad9f2ced47bb3a32cb37eab82a938f479d585131",
      format: "zip",
      verify: ["Orca.app/Contents/Resources/app.asar.unpacked/out/cli/index.js"],
    };
  }
  if (id === "openharness" && ["darwin", "linux"].includes(platform)) {
    return {
      id,
      version: "installer-e7f9ee4",
      url: "https://raw.githubusercontent.com/autonomous-ai/openharness/e7f9ee40384a4d517f673e30d5ccf56c60fbe1e5/cli/scripts/install.sh",
      sha256: "b2ddebc42c9a3ca3c6c895f10cd984b229b69e08744d8d55c5b4afb169c25a44",
      format: "script",
      verify: [],
    };
  }
  return null;
}

export const INTEGRATED_SETUP_IDS = [
  "agents",
  "codey",
  "hydra",
  "codeg",
  "alethe",
  "orca",
  "openharness",
  "docker-skills",
];
