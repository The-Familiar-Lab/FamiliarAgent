import type { TerminalExitInfo } from "./terminal.js";

const MAX_RECENT_EXITS = 32;
const EXIT_RETENTION_MS = 5 * 60 * 1000;

/** Keep only small exit diagnostics, never a dead PTY or its scrollback buffer. */
export class TerminalExitCache {
  private readonly entries = new Map<string, { at: number; info: TerminalExitInfo }>();

  set(id: string, info: TerminalExitInfo): void {
    this.entries.delete(id);
    this.entries.set(id, { at: Date.now(), info });
    while (this.entries.size > MAX_RECENT_EXITS) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  get(id: string): TerminalExitInfo | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.at > EXIT_RETENTION_MS) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.info;
  }
}

export function describeTerminalExit(info: TerminalExitInfo): string {
  let reason = "unknown exit code";
  if (info.signal !== null) reason = `signal ${info.signal}`;
  else if (info.exitCode !== null) reason = `exit code ${info.exitCode}`;
  return [`Terminal exited (${reason})`, ...info.lastOutputLines].join("\n");
}
