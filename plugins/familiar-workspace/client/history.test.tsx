// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ConversationLibrary } from "./history.js";
const mocks = vi.hoisted(() => ({
  hosts: [
    { serverId: "mac", label: "Mac", status: "online" },
    { serverId: "linux", label: "Ubuntu", status: "online" },
  ],
  load: vi.fn(async () => ({
    entries: [],
    total: 0,
    hasMore: false,
    errors: [],
    job: { running: false, imported: 0, skipped: 0, errors: [] },
  })),
}));
vi.mock("@getpaseo/plugin/client", () => ({ useHosts: () => mocks.hosts }));
vi.mock("./history-fleet.js", () => ({ loadHistoryFleet: mocks.load }));
vi.mock("./fleet.js", () => ({ hostRpc: vi.fn() }));
const props = { host: { id: "mac", label: "Mac" }, theme: { colors: {} } } as PluginSurfaceProps;
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("opens the requested server's history and keeps the library's All servers choice available", async () => {
  const view = render(<ConversationLibrary {...props} initialServerId="linux" />);
  await waitFor(() =>
    expect(mocks.load).toHaveBeenCalledWith(
      [mocks.hosts[1]],
      expect.any(Object),
      expect.any(Function),
    ),
  );
  expect(view.getByRole("button", { name: "Scan history" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "All servers" }));
  await waitFor(() =>
    expect(mocks.load).toHaveBeenLastCalledWith(
      mocks.hosts,
      expect.any(Object),
      expect.any(Function),
    ),
  );
  expect(view.getByRole("button", { name: "Scan all connected servers" })).toBeTruthy();
  view.rerender(<ConversationLibrary {...props} initialServerId="mac" />);
  await waitFor(() =>
    expect(mocks.load).toHaveBeenLastCalledWith(
      [mocks.hosts[0]],
      expect.any(Object),
      expect.any(Function),
    ),
  );
});
it("defaults a standalone library to all connected servers", async () => {
  render(<ConversationLibrary {...props} />);
  await waitFor(() =>
    expect(mocks.load).toHaveBeenCalledWith(mocks.hosts, expect.any(Object), expect.any(Function)),
  );
});
