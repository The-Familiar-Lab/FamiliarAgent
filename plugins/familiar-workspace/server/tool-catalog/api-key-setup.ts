import path from "node:path";
import type { z } from "zod";
import { apiKeyProvider } from "../../shared/tool-setup.js";

const VARIABLES = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

// getpass owns secret input: values never enter RPC, process arguments or terminal output.
export const API_KEY_SETUP = String.raw`
import getpass, os, pathlib, stat, sys, tempfile, warnings
warnings.simplefilter("error", getpass.GetPassWarning)
target, variable = sys.argv[1:]
if not sys.stdin.isatty():
    raise SystemExit("Open this setup in FamiliarAgent's interactive terminal.")
folder = pathlib.Path(target).parent
folder.mkdir(mode=0o700, parents=True, exist_ok=True)
info = folder.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
    raise SystemExit("The credential folder must be owned by you with mode 0700.")
if os.path.lexists(target):
    info = os.lstat(target)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SystemExit("Existing credential file must be owned by you with mode 0600.")
    if input("Replace the saved key for this provider? Type yes: ").strip() != "yes":
        raise SystemExit("No changes made.")
try:
    secret = getpass.getpass("Paste your API key (hidden), then press Enter: ")
except (EOFError, KeyboardInterrupt):
    raise SystemExit("\nCancelled. No key was saved.")
if not secret or len(secret) > 8192 or any(c.isspace() or ord(c) < 32 or c in "'\"\\" for c in secret):
    raise SystemExit("Invalid key. Paste one API key without whitespace or quotes.")
temporary = None
try:
    fd, temporary = tempfile.mkstemp(prefix=".key-", dir=folder)
    with os.fdopen(fd, "w") as out:
        out.write(variable + "='" + secret + "'\n")
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, target)
finally:
    if temporary and os.path.exists(temporary):
        os.unlink(temporary)
print("API key saved privately on this server. Return to FamiliarAgent and choose Check setup.")
print("A real model request is still needed to verify the provider accepts it.")
`;

export function apiKeySetup(root: string, rawProvider: z.infer<typeof apiKeyProvider>) {
  const provider = apiKeyProvider.parse(rawProvider);
  return {
    file: path.join(root, "tools", "credentials", `aider-${provider}.env`),
    variable: VARIABLES[provider],
  };
}
