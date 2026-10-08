import { describe, expect, it, vi } from "vitest";
import { readResourceCatalog, shareHttpWithHosts, mapSkillOnHost } from "./resources.js";
import type { ResourceDocument } from "../../shared/tool-catalog.js";
import type { PluginHostSummary } from "@getpaseo/plugin/client";
const hosts: PluginHostSummary[] = [
  { serverId: "mac", label: "Mac", status: "online" },
  { serverId: "linux", label: "Ubuntu", status: "online" },
  { serverId: "away", label: "Away", status: "offline" },
];
describe("all-host resource catalog", () => {
  it("keeps identical revisions and resource names scoped to their owning servers", async () => {
    const read = vi.fn(async (serverId: string) => ({
      revision: 1,
      skills: [{ id: "shared-name", path: `/${serverId}/skills`, enabled: true }],
      mcp: [],
    }));
    const entries = await readResourceCatalog(hosts, read);
    expect(
      entries.map((entry) => [entry.serverId, entry.value?.skills[0]?.path, entry.error]),
    ).toEqual([
      ["mac", "/mac/skills", undefined],
      ["linux", "/linux/skills", undefined],
      ["away", undefined, "Disconnected"],
    ]);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("preserves successful hosts when one server fails without reusing another server's document", async () => {
    const entries = await readResourceCatalog(hosts, async (serverId) => {
      if (serverId === "linux") throw new Error("RPC disconnected");
      return { revision: 3, skills: [], mcp: [] };
    });
    expect(entries[0]?.value?.revision).toBe(3);
    expect(entries[1]).toEqual({ serverId: "linux", label: "Ubuntu", error: "RPC disconnected" });
  });
});

describe("sharing resources across existing hosts", () => {
  it("uses each target's latest revision and reports partial HTTP MCP failure independently", async () => {
    const read = vi.fn(async (serverId: string) => ({
      revision: serverId === "mac" ? 7 : 12,
      skills: [],
      mcp: [],
    }));
    const apply = vi.fn(async (serverId: string, revision: number) => {
      if (serverId === "linux") throw new Error("A different MCP already uses this name");
      expect(revision).toBe(7);
      return { status: "added" as const };
    });
    const result = await shareHttpWithHosts(
      { id: "docs", type: "http", url: "https://mcp.example/tools", enabled: true },
      hosts,
      read,
      apply,
    );
    expect(result).toEqual([
      "Mac: Added",
      "Ubuntu: A different MCP already uses this name",
      "Away: Disconnected",
    ]);
    expect(apply.mock.calls.map(([owner, revision]) => [owner, revision])).toEqual([
      ["mac", 7],
      ["linux", 12],
    ]);
    await expect(
      shareHttpWithHosts(
        { id: "local", type: "http", url: "http://localhost:9000", enabled: true },
        hosts,
        read,
        apply,
      ),
    ).rejects.toThrow();
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it("maps an existing target skill path without replacing another mapping or touching source files", async () => {
    const read = vi.fn(async () => ({ revision: 12, skills: [], mcp: [] }));
    const save = vi.fn(async (_server: string, document: ResourceDocument) => ({
      ...document,
      revision: 13,
    }));
    const skill = { id: "review", path: "/ubuntu/shared/skill", enabled: true };
    await expect(mapSkillOnHost("linux", skill, read, save)).resolves.toBe("added");
    expect(save).toHaveBeenCalledWith("linux", { revision: 12, skills: [skill], mcp: [] });
    await expect(
      mapSkillOnHost(
        "linux",
        skill,
        async () => ({ revision: 13, skills: [skill], mcp: [] }),
        save,
      ),
    ).resolves.toBe("unchanged");
    await expect(
      mapSkillOnHost(
        "linux",
        skill,
        async () => ({ revision: 13, skills: [{ ...skill, path: "/another/skill" }], mcp: [] }),
        save,
      ),
    ).rejects.toThrow("different mapping");
    expect(save).toHaveBeenCalledOnce();
  });
});
