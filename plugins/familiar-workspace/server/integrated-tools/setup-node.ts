/** Terminal environments intentionally remove Electron controls. Carry Node mode in
 * the argv contract so a packaged helper also works from an ordinary agent shell. */
export function nodeToolCommand(node: string, args: string[], platform: string = process.platform) {
  if (platform === "win32") return { command: node, args };
  return { command: "/usr/bin/env", args: ["ELECTRON_RUN_AS_NODE=1", node, ...args] };
}
