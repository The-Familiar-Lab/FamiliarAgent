import { createRequire } from "node:module";
import { expect, it } from "vitest";

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
interface Lock {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
}
interface RuntimeManifest {
  dependencies: Record<string, string>;
  overrides: Record<string, unknown>;
}
const { createRuntimeManifest, verifyRuntimeLock } = createRequire(import.meta.url)(
  "../../../scripts/runtime-dependencies.cjs",
) as {
  createRuntimeManifest: (
    root: { version: string; overrides?: Record<string, unknown> },
    lock: Lock,
    workspaces: Array<{ directory: string; manifest: Manifest }>,
  ) => RuntimeManifest;
  verifyRuntimeLock: (manifest: RuntimeManifest, lock: Lock) => void;
};

it("packages current internal manifests and pins external versions per consuming workspace", () => {
  const root = { version: "0.12.0", overrides: { "proxy-addr@^2.0.0": "2.0.8" } };
  const lock = {
    packages: {
      "node_modules/ws": { version: "8.22.0" },
      "node_modules/express": { version: "4.22.1" },
      "node_modules/yaml": { version: "2.9.0" },
      "packages/server/node_modules/yaml": { version: "2.8.3" },
    },
  };
  const manifest = createRuntimeManifest(root, lock, [
    {
      directory: "packages/cli",
      manifest: {
        name: "@getpaseo/cli",
        version: "0.11.1",
        dependencies: { "@getpaseo/server": "0.11.1", ws: "^8.22.0", yaml: "^2.8.4" },
      },
    },
    {
      directory: "packages/server",
      manifest: {
        name: "@getpaseo/server",
        version: "0.11.1",
        dependencies: { yaml: "^2.8.0", express: "^4.18.2" },
      },
    },
  ]);
  expect(manifest.dependencies).toEqual({
    "@getpaseo/cli": "file:workspace-packages/getpaseo-cli-0.11.1.tgz",
    "@getpaseo/server": "file:workspace-packages/getpaseo-server-0.11.1.tgz",
  });
  expect(manifest.overrides).toEqual({
    "proxy-addr@^2.0.0": "2.0.8",
    "@getpaseo/cli": { "ws@^8.22.0": "8.22.0", "yaml@^2.8.4": "2.9.0" },
    "@getpaseo/server": { "yaml@^2.8.0": "2.8.3", "express@^4.18.2": "4.22.1" },
  });
  expect(root.overrides).toEqual({ "proxy-addr@^2.0.0": "2.0.8" });
});

it("refuses unresolved external dependencies instead of silently choosing registry latest", () => {
  expect(() =>
    createRuntimeManifest({ version: "0.12.0" }, { packages: {} }, [
      {
        directory: "packages/cli",
        manifest: { name: "@getpaseo/cli", version: "0.11.1", dependencies: { ws: "*" } },
      },
    ]),
  ).toThrow("missing from the root lock");
});

it("requires portable integrity-pinned internal tarballs, including nested internal copies", () => {
  const source = "file:workspace-packages/cli.tgz";
  const manifest = { dependencies: { "@getpaseo/cli": source }, overrides: {} };
  const entry = { resolved: source, integrity: "sha512-owned-fixture" };
  const lock = { packages: { "node_modules/@getpaseo/cli": entry } };
  expect(() => verifyRuntimeLock(manifest, lock)).not.toThrow();
  expect(() =>
    verifyRuntimeLock(manifest, {
      packages: { "node_modules/@getpaseo/cli": { resolved: source } },
    }),
  ).toThrow("bundled workspace");
  expect(() =>
    verifyRuntimeLock(manifest, {
      packages: {
        ...lock.packages,
        "node_modules/example/node_modules/@getpaseo/cli": {
          ...entry,
          resolved: "https://registry.example/cli.tgz",
        },
      },
    }),
  ).toThrow("different internal workspace");
  expect(() =>
    verifyRuntimeLock(manifest, {
      packages: {
        ...lock.packages,
        "../private/node_modules/example": { version: "1.0.0" },
      },
    }),
  ).toThrow("nonportable location");
});
