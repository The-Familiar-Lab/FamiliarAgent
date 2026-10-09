import type { TerminalState } from "@getpaseo/protocol/messages";

export interface TerminalWebView {
  title: string;
  url: string;
  preserveHost: boolean;
}

const MAX_READINESS_LINE = 4096;
const MAX_SNAPSHOT_ROWS = 500;

function parseReadinessLine(line: string): TerminalWebView | null {
  const match = /^Pullboard view: (http:\/\/[^\s]+)\s*$/.exec(line);
  if (
    !match ||
    [...match[1]].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "\\",
    )
  )
    return null;
  try {
    const url = new URL(match[1]);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/" ||
      !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get("k") ?? "")
    )
      return null;
    return { title: "Pullboard", url: url.href, preserveHost: true };
  } catch {
    return null;
  }
}

/** Consumes the existing stream; never polls, executes output, or retains scrollback. */
export class TerminalWebViewDetector {
  private decoder = new TextDecoder();
  private line = "";
  private overflow = false;
  private escape: "none" | "start" | "csi" | "osc" | "oscEnd" = "none";

  feed(data: Uint8Array | string): TerminalWebView | null {
    const text = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    let latest: TerminalWebView | null = null;
    for (const char of text) {
      if (this.consumeEscape(char)) continue;
      if (char === "\n") {
        if (!this.overflow) latest = parseReadinessLine(this.line) ?? latest;
        this.line = "";
        this.overflow = false;
      } else if (char !== "\r" && !this.overflow) {
        this.line += char;
        if (this.line.length > MAX_READINESS_LINE) {
          this.line = "";
          this.overflow = true;
        }
      }
    }
    return latest;
  }

  private consumeEscape(char: string): boolean {
    if (this.escape === "osc" || this.escape === "oscEnd") {
      if (char === "\x07" || (this.escape === "oscEnd" && char === "\\")) this.escape = "none";
      else this.escape = char === "\x1b" ? "oscEnd" : "osc";
      return true;
    }
    if (this.escape === "start") {
      if (char === "[") this.escape = "csi";
      else if (char === "]") this.escape = "osc";
      else this.escape = "none";
      return true;
    }
    if (this.escape === "csi") {
      if (char >= "@" && char <= "~") this.escape = "none";
      return true;
    }
    if (char === "\x1b") {
      this.escape = "start";
      return true;
    }
    return false;
  }

  snapshot(state: TerminalState): TerminalWebView | null {
    this.reset();
    const rows = [...state.scrollback.slice(-MAX_SNAPSHOT_ROWS), ...state.grid];
    const flags = [
      ...(state.scrollbackWrapped?.slice(-MAX_SNAPSHOT_ROWS) ?? []),
      ...(state.gridWrapped ?? []),
    ];
    let latest: TerminalWebView | null = null;
    rows.forEach((row, index) => {
      const wrapped = flags.length === rows.length && flags[index];
      const text = row.map((cell) => cell.char || " ").join("");
      latest = this.feed(wrapped ? text : `${text.trimEnd()}\n`) ?? latest;
    });
    return latest;
  }

  reset(): void {
    this.decoder = new TextDecoder();
    this.line = "";
    this.overflow = false;
    this.escape = "none";
  }
}

/** In-memory, workspace-owned deduplication survives terminal panel remounts. */
export class TerminalWebViewRegistry {
  private entries = new Map<
    string,
    { view: TerminalWebView; attempted: boolean; browserId?: string }
  >();
  get(terminalId: string): TerminalWebView | null {
    return this.entries.get(terminalId)?.view ?? null;
  }
  observe(terminalId: string, view: TerminalWebView): void {
    if (this.get(terminalId)?.url !== view.url)
      this.entries.set(terminalId, { view, attempted: false });
  }
  claim(terminalId: string): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry || entry.attempted) return false;
    entry.attempted = true;
    return true;
  }
  retry(terminalId: string, url: string): void {
    const entry = this.entries.get(terminalId);
    if (entry?.view.url === url && !entry.browserId) entry.attempted = false;
  }
  browserId(terminalId: string): string | undefined {
    return this.entries.get(terminalId)?.browserId;
  }
  opened(terminalId: string, url: string, browserId: string): void {
    const entry = this.entries.get(terminalId);
    if (entry?.view.url === url) entry.browserId = browserId;
  }
  clear(terminalId: string): void {
    this.entries.delete(terminalId);
  }
  prune(terminalIds: string[]): void {
    const ids = new Set(terminalIds);
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
  }
}
