// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DirectoryBrowser,
  childDirectory,
  parentDirectory,
  useDirectoryListing,
} from "./directory-browser";
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
function directoryClient(
  listDirectory: (
    cwd: string,
    path: string,
  ) => Promise<{ entries: { name: string; kind: "file" | "directory" }[] }>,
) {
  return { listDirectory };
}
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("browses remote children and parents, shows hidden folders on demand, and selects only the current successful folder", async () => {
  const client = directoryClient(
    vi.fn(async (cwd: string) => ({
      entries:
        cwd === "/home"
          ? [
              { name: "repo", kind: "directory" as const },
              { name: ".config", kind: "directory" as const },
              { name: "private.txt", kind: "file" as const },
            ]
          : [],
    })),
  );
  const select = vi.fn();
  render(
    <DirectoryBrowser
      client={client}
      initialPath="/home"
      serverName="Ubuntu"
      onSelect={select}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open folder repo" }));
  expect(await screen.findByText("No folders here.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
  expect(select).toHaveBeenLastCalledWith("/home/repo");
  fireEvent.click(screen.getByRole("button", { name: "Up" }));
  await screen.findByRole("button", { name: "Open folder repo" });
  expect(screen.queryByRole("button", { name: "Open folder .config" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Open folder .config" })).toBeTruthy();
  expect(screen.queryByText("private.txt")).toBeNull();
  expect(client.listDirectory).toHaveBeenCalledWith("/home/repo", "");
});

it("surfaces permission failures, disables selection, and retries without changing the selected host", async () => {
  const client = directoryClient(
    vi
      .fn()
      .mockRejectedValueOnce(new Error("Permission denied"))
      .mockResolvedValue({ entries: [] }),
  );
  const select = vi.fn();
  render(
    <DirectoryBrowser
      client={client}
      initialPath="/protected"
      serverName="SSH host"
      onSelect={select}
      onClose={vi.fn()}
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toBe("Permission denied");
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No folders here.");
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("/protected");
});

it("ignores a late listing from the previous server or folder", async () => {
  let resolveOld!: (value: { entries: { name: string; kind: "directory" }[] }) => void;
  const old = {
    listDirectory: vi.fn(
      () =>
        new Promise<{ entries: { name: string; kind: "directory" }[] }>((resolve) => {
          resolveOld = resolve;
        }),
    ),
  };
  const current = {
    listDirectory: vi.fn(async () => ({
      entries: [{ name: "right-server", kind: "directory" as const }],
    })),
  };
  const { result, rerender } = renderHook(({ client, path }) => useDirectoryListing(client, path), {
    initialProps: { client: old, path: "/home" },
  });
  rerender({ client: current, path: "/srv" });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    resolveOld({ entries: [{ name: "wrong-server", kind: "directory" }] });
  });
  expect(result.current.entries.map((entry) => entry.name)).toEqual(["right-server"]);
  expect(result.current.path).toBe("/srv");
});

it("keeps POSIX roots stable and rejects names that could escape a clicked folder", () => {
  expect(parentDirectory("/")).toBe("/");
  expect(parentDirectory("/home/user/")).toBe("/home");
  expect(childDirectory("/", "home")).toBe("/home");
  for (const name of ["..", "../secrets", "nested/path", "nested\\path"])
    expect(() => childDirectory("/home", name)).toThrow("invalid directory");
});
