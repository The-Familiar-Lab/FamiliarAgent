import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { familiarPaths, familiarStateBeforeMigration, prepareFamiliarLayout } from "./paths.js";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "familiar-layout-"));
  homes.push(home);
  const legacyDesktop = path.join(home, "Library", "Application Support", "FamiliarAgent");
  mkdirSync(path.join(legacyDesktop, "daemon"), { recursive: true });
  writeFileSync(path.join(legacyDesktop, "daemon", "server-id"), "same-server");
  writeFileSync(path.join(legacyDesktop, "window-state.json"), "same-layout");
  return { home, legacyDesktop };
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("uniform FamiliarAgent data layout", () => {
  it("moves existing state without copying file contents and keeps old paths readable", () => {
    const input = fixture();
    const oldFile = path.join(input.legacyDesktop, "daemon", "server-id");
    const before = statSync(oldFile).ino;
    const result = prepareFamiliarLayout(input);
    expect(result.migrated).toBe(true);
    expect(result.deferred).toBe(false);
    expect(statSync(path.join(result.paths.state, "server-id")).ino).toBe(before);
    expect(readFileSync(oldFile, "utf8")).toBe("same-server");
    expect(realpathSync(input.legacyDesktop)).toBe(realpathSync(result.paths.desktop));
    expect(readFileSync(path.join(result.paths.desktop, "window-state.json"), "utf8")).toBe(
      "same-layout",
    );
    expect(prepareFamiliarLayout(input).migrated).toBe(false);
  });
  it("rejects conflicting state without moving either installation", () => {
    const input = fixture();
    const state = familiarPaths(input.home).state;
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, "server-id"), "different-server");
    expect(() => prepareFamiliarLayout(input)).toThrow("Both FamiliarAgent locations contain data");
    expect(readFileSync(path.join(state, "server-id"), "utf8")).toBe("different-server");
    expect(readFileSync(path.join(input.legacyDesktop, "daemon", "server-id"), "utf8")).toBe(
      "same-server",
    );
  });
  it("defers relocation while the old app or daemon remains active", () => {
    const input = fixture();
    writeFileSync(
      path.join(input.legacyDesktop, "daemon", "paseo.pid"),
      JSON.stringify({ pid: 45678 }),
    );
    const result = prepareFamiliarLayout({ ...input, isProcessAlive: (pid) => pid === 45678 });
    expect(result.deferred).toBe(true);
    expect(result.paths.state).toBe(path.join(input.legacyDesktop, "daemon"));
    expect(result.migrated).toBe(false);
  });
  it("does not follow an unrelated user-provided profile symlink", () => {
    const input = fixture();
    const other = path.join(input.home, "other");
    mkdirSync(other);
    symlinkSync(other, path.join(input.legacyDesktop, "discord"));
    expect(() => prepareFamiliarLayout(input)).toThrow("unrelated symbolic link");
  });
  it("uses the legacy state for CLI-first launches and the canonical location after relocation", () => {
    const input = fixture();
    expect(familiarStateBeforeMigration(input.legacyDesktop, input.home)).toBe(
      path.join(input.legacyDesktop, "daemon"),
    );
    prepareFamiliarLayout(input);
    expect(familiarStateBeforeMigration(input.legacyDesktop, input.home)).toBe(
      familiarPaths(input.home).state,
    );
  });
  it("adopts an existing server state on a first desktop launch", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "familiar-server-layout-"));
    homes.push(home);
    const paths = familiarPaths(home);
    mkdirSync(paths.state, { recursive: true });
    writeFileSync(path.join(paths.state, "server-id"), "linux-server");
    const result = prepareFamiliarLayout({
      home,
      legacyDesktop: path.join(home, ".config", "FamiliarAgent"),
    });
    expect(result.migrated).toBe(false);
    expect(readFileSync(path.join(result.paths.state, "server-id"), "utf8")).toBe("linux-server");
  });
});
