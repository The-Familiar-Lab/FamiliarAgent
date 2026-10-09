import path from "node:path";
import type { ToolPlan } from "../../shared/tool-catalog.js";
import { INFRASTRUCTURE_RELEASES } from "./installer-releases.js";
import { INFRASTRUCTURE_INSTALLER } from "./installer-program.js";

export async function prepareInfrastructureInstaller(options: {
  id: string;
  root: string;
  cwd: string;
  platform: NodeJS.Platform;
  arch?: string;
  executable: (name: string) => Promise<string | undefined>;
}): Promise<ToolPlan | null> {
  if (!Object.hasOwn(INFRASTRUCTURE_RELEASES, options.id)) return null;
  const recipe = INFRASTRUCTURE_RELEASES[options.id as keyof typeof INFRASTRUCTURE_RELEASES];
  const key = `${options.platform}-${options.arch ?? process.arch}`;
  const platforms: Record<string, readonly object[]> = recipe.platforms;
  const assets = platforms[key];
  if (!assets) {
    if (options.id === "firetower")
      throw new Error(
        "Firetower's control plane runs on Linux. Use the installation on a connected Linux server; macOS can run its original worker and connect to that service.",
      );
    throw new Error(`No verified ${options.id} release for ${key}. Use the original source setup.`);
  }
  const python = await options.executable("python3");
  if (!python) throw new Error("Python 3 is required to verify and install this native release.");
  return {
    toolId: options.id,
    action: "install",
    mode: "terminal",
    cwd: options.cwd,
    command: python,
    args: [
      "-c",
      INFRASTRUCTURE_INSTALLER,
      JSON.stringify({
        root: path.resolve(options.root),
        id: options.id,
        version: recipe.version,
        assets,
      }),
    ],
    notes: [
      "Installs the original pinned release after SHA-256 verification into this server's private tools folder. Existing accounts, projects and running services are preserved.",
      "This installs executables only. Use the original setup or Ask agent to set up for service, SSH, database and workspace configuration; installation is not a functional readiness check.",
    ],
  };
}
