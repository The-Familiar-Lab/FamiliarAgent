import { describe, expect, it, vi } from "vitest";
import { loadHistoryFleet } from "./history-fleet.js";
import type { PluginHostSummary } from "@getpaseo/plugin/client";
import type { HistorySummary } from "../shared/history.js";

const hosts: PluginHostSummary[] = [
  { serverId: "mac", label: "Mac", status: "online" },
  { serverId: "linux", label: "Ubuntu", status: "online" },
  { serverId: "away", label: "Away", status: "offline" },
];
const record: HistorySummary = {
  id: "a".repeat(64),
  nativeId: "same-native",
  title: "Original",
  source: "Codex",
  origin: "/source/original.jsonl",
  workspace: "/project",
  updatedAt: "2026-10-08",
  messageCount: 3,
  hidden: false,
  notes: [],
};
const job = { running: false, imported: 1, skipped: 0, errors: [] as string[] };
describe("all-server conversation library", () => {
  it("preserves owning server even when native records have the same IDs", async () => {
    const request = vi.fn(async (serverId: string) => ({
      entries: [{ ...record, updatedAt: serverId === "linux" ? "2026-10-09" : "2026-10-08" }],
      total: 1,
      job,
    }));
    const page = await loadHistoryFleet(
      hosts,
      { query: "project", offset: 0, limit: 30, includeHidden: false },
      request,
    );
    expect(page.entries.map((item) => [item.id, item.serverId, item.serverLabel])).toEqual([
      [record.id, "linux", "Ubuntu"],
      [record.id, "mac", "Mac"],
    ]);
    expect(page.total).toBe(2);
    expect(page.errors).toEqual([
      "Away: Disconnected. Reconnect to read its original conversations.",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.hasMore).toBe(false);
  });
  it("shows partial host failure while preserving bounded per-server pagination and scan state", async () => {
    const input = { query: "ssh", includeHidden: true, offset: 30, limit: 30 };
    const request = vi.fn(async (serverId: string) => {
      if (serverId === "linux") throw new Error("Plugin update required");
      return {
        entries: [record],
        total: 90,
        job: { ...job, running: true, errors: ["Damaged source line"] },
      };
    });
    const page = await loadHistoryFleet(hosts.slice(0, 2), input, request);
    expect(request).toHaveBeenCalledWith("mac", input);
    expect(request).toHaveBeenCalledWith("linux", input);
    expect(page.errors).toEqual(["Ubuntu: Plugin update required"]);
    expect(page.hasMore).toBe(true);
    expect(page.job.running).toBe(true);
    expect(page.job.errors).toEqual(["Mac: Damaged source line"]);
    expect(page.entries[0]?.serverId).toBe("mac");
  });
  it("only addresses the explicitly selected server", async () => {
    const request = vi.fn(async () => ({ entries: [], total: 0, job }));
    const result = await loadHistoryFleet([hosts[1]!], { offset: 0, limit: 30 }, request);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("linux", { offset: 0, limit: 30 });
    expect(result.total).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
