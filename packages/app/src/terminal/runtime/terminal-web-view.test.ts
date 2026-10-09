import { describe, expect, it } from "vitest";
import { TerminalWebViewDetector, TerminalWebViewRegistry } from "./terminal-web-view";

const url = "http://127.0.0.1:43123/?k=test-private-key";
const line = `Pullboard view: ${url}\r\n`;
const toCell = (char: string) => ({ char });
const view = { title: "Pullboard", url, preserveHost: true };

describe("terminal web view readiness", () => {
  it("opens only a completed announcement, including every possible chunk split", () => {
    for (let index = 1; index < line.length - 1; index++) {
      const detector = new TerminalWebViewDetector();
      expect(detector.feed(new TextEncoder().encode(line.slice(0, index)))).toBeNull();
      expect(detector.feed(new TextEncoder().encode(line.slice(index)))).toEqual(view);
    }
  });
  it("handles ANSI styles, OSC titles and multiple lines in one chunk", () => {
    const detector = new TerminalWebViewDetector();
    detector.feed("\x1b]0;Private title");
    expect(
      detector.feed(`\x07\x1b[32m${line.trim()}\x1b[0m\r\nOnly this machine can reach it.\r\n`),
    ).toEqual(view);
  });
  it.each([
    `echo Pullboard view: ${url}`,
    `Documentation: ${url}`,
    `Pullboard view: https://example.com/`,
    `Pullboard view: http://example.com:43123/?k=test`,
    `Pullboard view: http://localhost/?k=test`,
    `Pullboard view: http://user:password@localhost:43123/?k=test`,
    `Pullboard view: http://localhost:43123/other?k=test`,
    `Pullboard view: http://localhost:43123/?k=test#fragment`,
    `Pullboard view: http://localhost:43123/?k=test\\other`,
    `Pullboard view: http://localhost:43123/`,
    `Pullboard view: file:///tmp/view`,
  ])("ignores unsafe or unrelated output: %s", (input) => {
    expect(new TerminalWebViewDetector().feed(`${input}\n`)).toBeNull();
  });
  it("bounds an unterminated line and recovers at the next newline", () => {
    const detector = new TerminalWebViewDetector();
    expect(detector.feed("x".repeat(100_000) + line)).toBeNull();
    expect(detector.feed(line)).toEqual(view);
  });
  it("opens Codeg only from its original bound-server announcement, without copying its token", () => {
    const prefix = "2026-10-09T19:19:48.647020Z  INFO codeg_server: ";
    const detector = new TerminalWebViewDetector();
    expect(
      detector.feed("[SERVER] Token: secret-credential\n" + prefix + "[SERVER] Listening on:\n"),
    ).toBeNull();
    const codegView = detector.feed(prefix + "  http://127.0.0.1:40039\n");
    expect(codegView).toEqual({
      title: "Codeg",
      url: "http://127.0.0.1:40039/",
      preserveHost: false,
    });
    expect(JSON.stringify(codegView)).not.toContain("secret-credential");
    expect(detector.feed("Codeg view: http://127.0.0.1:40039\n")).toEqual(codegView);
    expect(detector.feed("Codeg view: http://127.0.0.1:40039/?token=secret\n")).toBeNull();
    expect(detector.feed(prefix + "  http://127.0.0.1:40039\n")).toBeNull();
    expect(
      detector.feed(prefix + "[SERVER] Listening on:\n" + prefix + "http://example.com:40039/\n"),
    ).toBeNull();
    expect(
      detector.feed(
        prefix +
          "[SERVER] Listening on:\n[SERVER] Token: ignored\n" +
          prefix +
          "http://127.0.0.1:40039/\n",
      ),
    ).toBeNull();
  });
  it("recognizes the original superharness dashboard and project announcement across chunks", () => {
    const detector = new TerminalWebViewDetector();
    const announcement = "dashboard: http://127.0.0.1:47878\r\nproject: /tmp/my project\r\n";
    for (let index = 1; index < announcement.length; index++) {
      detector.reset();
      expect(detector.feed(announcement.slice(0, index))).toBeNull();
      expect(detector.feed(announcement.slice(index))).toEqual({
        title: "superharness",
        url: "http://127.0.0.1:47878/",
        preserveHost: true,
      });
    }
  });
  it.each([
    "dashboard: http://127.0.0.1:47878\n",
    "dashboard: http://127.0.0.1:47878\nother output\nproject: /tmp/project\n",
    "dashboard: http://example.com:47878\nproject: /tmp/project\n",
    "dashboard: http://127.0.0.1:47878/?token=secret\nproject: /tmp/project\n",
    "dashboard: http://127.0.0.1:47878\nproject: \n",
    "dashboard: http://127.0.0.1:47878\n" + "x".repeat(5000) + "\nproject: /tmp/project\n",
  ])("does not open incomplete, unrelated or unsafe dashboard output", (input) => {
    expect(new TerminalWebViewDetector().feed(input)).toBeNull();
  });
  it("reconstructs a soft-wrapped snapshot and preserves its private query", () => {
    const text = line.trim();
    const cols = 30;
    const rows = [text.slice(0, cols), text.slice(cols, cols * 2), text.slice(cols * 2)];
    const grid = rows.map((row) => [...row].map(toCell));
    expect(
      new TerminalWebViewDetector().snapshot({
        rows: 3,
        cols,
        grid,
        scrollback: [],
        gridWrapped: [true, true, false],
        cursor: { row: 2, col: 0 },
      }),
    ).toEqual(view);
  });
  it("deduplicates replay/remounts but permits a new server URL and explicit reopening", () => {
    const registry = new TerminalWebViewRegistry();
    registry.observe("term", view);
    expect(registry.claim("term")).toBe(true);
    registry.opened("term", url, "browser");
    registry.observe("term", view);
    expect(registry.claim("term")).toBe(false);
    expect(registry.browserId("term")).toBe("browser");
    registry.observe("term", { ...view, url: url.replace("43123", "43124") });
    expect(registry.claim("term")).toBe(true);
    expect(registry.browserId("term")).toBeUndefined();
    registry.prune([]);
    expect(registry.get("term")).toBeNull();
  });
});
