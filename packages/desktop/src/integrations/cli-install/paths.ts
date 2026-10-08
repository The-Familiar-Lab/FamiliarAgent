import path from "node:path";
import { createRequire } from "node:module";
import { resolveCliShimPath } from "./path.js";
import os from "node:os";
import { app } from "electron";
import { familiarPaths } from "../../features/familiar/paths.js";

export function getLocalBinDir(): string {
  return path.join(os.homedir(), ".local", "bin");
}

export function getCliTargetPath(): string {
  const filename = process.platform === "win32" ? "familiar.cmd" : "familiar";
  return path.join(getLocalBinDir(), filename);
}

export function getStableCliTargetPath(): string {
  return path.join(familiarPaths().bin, process.platform === "win32" ? "familiar.cmd" : "familiar");
}

export function getBundledCliShimPath(): string {
  return resolveCliShimPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    resolveWorkspaceCli: () => createRequire(__filename).resolve("@getpaseo/cli/bin/paseo"),
  });
}
