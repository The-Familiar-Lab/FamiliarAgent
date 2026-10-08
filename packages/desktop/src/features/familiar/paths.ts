import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function familiarPaths(home = homedir()) {
  const root = path.join(home, ".local", "share", "familiaragent");
  return {
    root,
    state: path.join(root, "state"),
    desktop: path.join(root, "desktop"),
    discord: path.join(root, "discord"),
    bin: path.join(root, "bin"),
    providers: path.join(root, "providers", "node_modules", ".bin"),
  };
}

function statEntry(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameDirectory(left: string, right: string): boolean {
  return existsSync(left) && existsSync(right) && realpathSync(left) === realpathSync(right);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A running previous version keeps its profile until the next clean start. */
function legacyIsActive(directory: string, isAlive: (pid: number) => boolean): boolean {
  const singleton = path.join(directory, "SingletonLock");
  if (statEntry(singleton)?.isSymbolicLink()) {
    const pid = Number(readlinkSync(singleton).match(/-(\d+)$/u)?.[1]);
    if (pid > 0 && pid !== process.pid && isAlive(pid)) return true;
  }
  const pidFile = path.join(directory, "daemon", "paseo.pid");
  if (existsSync(pidFile)) {
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(pidFile, "utf8"));
    } catch {
      // A partially written lock is not evidence that the daemon is stopped.
      return true;
    }
    if (typeof record === "object" && record !== null && "pid" in record) {
      const pid = record.pid;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && isAlive(pid)) return true;
    }
  }
  return false;
}

/**
 * Relocate directories, retaining old paths as aliases. Never copy or merge a
 * live database. Conflicts fail before moving anything; failed moves roll back.
 */
export function prepareFamiliarLayout(input: {
  legacyDesktop: string;
  home?: string;
  isProcessAlive?: (pid: number) => boolean;
}): { paths: ReturnType<typeof familiarPaths>; deferred: boolean; migrated: boolean } {
  const paths = familiarPaths(input.home);
  const legacy = input.legacyDesktop;
  if (legacy === paths.desktop || sameDirectory(legacy, paths.desktop)) {
    return { paths, deferred: false, migrated: false };
  }
  if (statEntry(legacy) && legacyIsActive(legacy, input.isProcessAlive ?? processAlive)) {
    return {
      paths: {
        ...paths,
        desktop: legacy,
        state: path.join(legacy, "daemon"),
        discord: path.join(legacy, "discord"),
      },
      deferred: true,
      migrated: false,
    };
  }
  const moves = [
    [path.join(legacy, "daemon"), paths.state],
    [path.join(legacy, "discord"), paths.discord],
    [legacy, paths.desktop],
  ] as const;
  for (const [source, destination] of moves) {
    if (!statEntry(source) || sameDirectory(source, destination)) continue;
    if (statEntry(source)?.isSymbolicLink()) {
      throw new Error(`Cannot migrate an unrelated symbolic link: ${source}`);
    }
    if (statEntry(destination)) {
      throw new Error(
        `Both FamiliarAgent locations contain data: ${source} and ${destination}. Resolve the location conflict before starting.`,
      );
    }
  }
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const completed: Array<readonly [string, string]> = [];
  try {
    for (const [source, destination] of moves) {
      if (!statEntry(source) || sameDirectory(source, destination)) continue;
      renameSync(source, destination);
      try {
        symlinkSync(destination, source, "junction");
      } catch (error) {
        renameSync(destination, source);
        throw error;
      }
      completed.push([source, destination]);
    }
    for (const directory of [paths.state, paths.desktop, paths.discord, paths.bin]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  } catch (error) {
    for (let index = completed.length - 1; index >= 0; index--) {
      const [source, destination] = completed[index]!;
      unlinkSync(source);
      renameSync(destination, source);
    }
    throw error;
  }
  return { paths, deferred: false, migrated: completed.length > 0 };
}

/** CLI-only launches must still find a pre-migration desktop installation. */
export function familiarStateBeforeMigration(legacyDesktop: string, home = homedir()): string {
  const state = familiarPaths(home).state;
  const legacy = path.join(legacyDesktop, "daemon");
  return !existsSync(state) && existsSync(legacy) ? legacy : state;
}
