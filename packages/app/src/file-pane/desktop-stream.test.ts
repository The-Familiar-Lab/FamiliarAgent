import { expect, it, vi } from "vitest";
import type { HostProfile } from "@/types/host-connection";
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue({ url: "familiaragent://stream/test" }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => ({}) }));
vi.mock("@/desktop/electron/invoke", () => ({ invokeDesktopCommand: invoke }));
import { desktopFileStreamUrl } from "./desktop-stream";
it("streams through the live connection after failing over from a stale saved address", async () => {
  const profile = {
    preferredConnectionId: "stale",
    connections: [
      { id: "stale", type: "directTcp", endpoint: "localhost:6767" },
      { id: "live", type: "directTcp", endpoint: "127.0.0.1:6786" },
    ],
  } as HostProfile;
  await desktopFileStreamUrl(profile, "token", true, "live");
  expect(invoke).toHaveBeenLastCalledWith(
    "familiar_file_stream",
    expect.objectContaining({
      target: { transportType: "tcp", endpoint: "http://127.0.0.1:6786/ws" },
    }),
  );
});
