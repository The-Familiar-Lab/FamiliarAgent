import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { hostRpc } from "../fleet.js";
import { projectResources, sharedMcp } from "../../shared/tool-catalog.js";
import { ROW, HubTargetPicker, type HubUi } from "./ui.js";
import { mapSkillOnHost, shareHttpWithHosts, type HostResources } from "./resources.js";
import type { HubController, HubProps } from "./controller.js";
function memoryLabel(hub: HubController) {
  if (hub.session) return `Session memory: ${hub.session.title}`;
  if (hub.project) return `Project memory: ${hub.project.title}`;
  return "Select a project to edit shared memory";
}
interface SkillOrigin {
  serverId: string;
  label: string;
  id: string;
  path: string;
  enabled: boolean;
}
function ResourceHostCard({
  item,
  hub,
  ui,
  selectSkill,
}: {
  item: HostResources;
  hub: HubController;
  ui: HubUi;
  selectSkill: (value: SkillOrigin) => void;
}) {
  const shareHttp = async (entry: NonNullable<HostResources["value"]>["mcp"][number]) => {
    if (entry.type !== "http") return;
    const targets = hub.hosts.filter(
      (host) => host.status === "online" && host.serverId !== item.serverId,
    );
    const results = await shareHttpWithHosts(entry, targets);
    hub.setNotice(results.join("\n"));
    await hub.reloadResources();
  };
  return (
    <View style={ui.card}>
      <Text style={ui.text}>{item.label}</Text>
      {item.error ? (
        <Text style={ui.error}>{item.error}</Text>
      ) : (
        <>
          {item.value?.skills.map((skill) => (
            <View key={skill.id}>
              <Text style={ui.muted}>
                {skill.id} · {item.label}: {skill.path}
              </Text>
              {ui.button("Map on another server", () =>
                selectSkill({ ...skill, serverId: item.serverId, label: item.label }),
              )}
            </View>
          ))}
          {item.value?.mcp.map((entry) => (
            <View key={entry.id}>
              <Text style={ui.muted}>
                {entry.id} · {entry.type}
              </Text>
              {entry.type === "http" ? (
                ui.button(
                  "Use on connected servers",
                  () => {
                    void hub.run(() => shareHttp(entry));
                  },
                  !entry.enabled ||
                    !hub.hosts.some(
                      (host) => host.status === "online" && host.serverId !== item.serverId,
                    ),
                )
              ) : (
                <Text style={ui.muted}>
                  This command runs on {item.label}. Configure its executable and arguments
                  separately on another server.
                </Text>
              )}
            </View>
          ))}
        </>
      )}
      {ui.button("Manage this server", () => hub.setTarget(item.serverId), !!item.error)}
    </View>
  );
}
export function HubMemory({ hub, ui }: { hub: HubController; ui: HubUi; props: HubProps }) {
  const [advanced, setAdvanced] = useState(false);
  const [skillOrigin, setSkillOrigin] = useState<SkillOrigin | null>(null);
  const [mappedPath, setMappedPath] = useState("");
  const [mcpType, setMcpType] = useState<"http" | "stdio">("http");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("[]");
  const selectSkill = useCallback((origin: SkillOrigin) => {
    setSkillOrigin(origin);
    setMappedPath("");
  }, []);
  if (hub.tab !== "Memory & Skills") return null;
  const resources = hub.resources;
  const toggleSkill = async (id: string) => {
    if (resources)
      await hub.saveOwnedResources({
        ...resources,
        skills: resources.skills.map((item) =>
          item.id === id ? { ...item, enabled: !item.enabled } : item,
        ),
      });
  };
  const toggleMcp = async (id: string) => {
    if (resources)
      await hub.saveOwnedResources({
        ...resources,
        mcp: resources.mcp.map((item) =>
          item.id === id ? { ...item, enabled: !item.enabled } : item,
        ),
      });
  };
  const addSkill = async () => {
    if (resources)
      await hub.saveOwnedResources({
        ...resources,
        skills: [
          ...resources.skills.filter((item) => item.id !== hub.skillName),
          { id: hub.skillName, path: hub.skillPath, enabled: true },
        ],
      });
  };
  const addMcp = async () => {
    if (resources)
      await hub.saveOwnedResources({
        ...resources,
        mcp: [
          ...resources.mcp.filter((item) => item.id !== hub.mcpName),
          sharedMcp.parse(
            mcpType === "http"
              ? { id: hub.mcpName, type: "http", url: hub.mcpUrl, enabled: true }
              : {
                  id: hub.mcpName,
                  type: "stdio",
                  command: mcpCommand,
                  args: JSON.parse(mcpArgs),
                  enabled: true,
                },
          ),
        ],
      });
  };
  const mapSkill = async () => {
    if (!skillOrigin || skillOrigin.serverId === hub.target)
      throw new Error("Select another destination server.");
    const owner = hub.target;
    const result = await mapSkillOnHost(owner, {
      id: skillOrigin.id,
      path: mappedPath.trim(),
      enabled: skillOrigin.enabled,
    });
    hub.setNotice(
      `${hub.hostName(owner)}: ${result === "added" ? "Skill mapping added" : "Already mapped"}. Original files were not copied.`,
    );
    await hub.reloadResources();
  };
  const applySkills = async (provider: "claude" | "codex" | "cursor") => {
    const result = await hostRpc(hub.target, projectResources, { cwd: hub.cwd, toolId: provider });
    hub.setNotice(
      [
        ...result.notes,
        ...result.conflicts.map((value) => `Conflict: ${value}`),
        `${result.paths.length} links created, ${result.unchanged.length} already linked.`,
      ].join("\n"),
    );
  };
  return (
    <>
      <View style={ui.card}>
        <Text style={ui.text}>{memoryLabel(hub)}</Text>
        {ui.field("Decisions, constraints and handoff notes", hub.memory, hub.setMemory, true)}
        <View style={ROW}>
          {ui.button(
            "Save shared memory",
            () => {
              void hub.run(hub.saveMemory);
            },
            !hub.project,
          )}
          {ui.button(
            "Reload memory",
            () => {
              void hub.run(hub.reloadMemory);
            },
            !hub.project,
          )}
        </View>
        <Text style={ui.muted}>
          If another agent changed this memory, reload the latest revision before saving. Reload
          replaces the text in this editor.
        </Text>
      </View>
      <Text style={ui.sectionHeading}>Skills & MCP · all servers</Text>
      {hub.resourceCatalog
        .filter((item) => hub.filter === "all" || item.serverId === hub.filter)
        .map((item) => (
          <ResourceHostCard
            key={item.serverId}
            item={item}
            hub={hub}
            ui={ui}
            selectSkill={selectSkill}
          />
        ))}
      {skillOrigin ? (
        <View style={ui.card}>
          <Text style={ui.text}>Map skill {skillOrigin.id}</Text>
          <Text selectable style={ui.muted}>
            Source: {skillOrigin.label} · {skillOrigin.path}
          </Text>
          <HubTargetPicker hub={hub} ui={ui} />
          {ui.field("Existing skill directory on destination server", mappedPath, setMappedPath)}
          <Text style={ui.muted}>
            Use an existing directory containing SKILL.md, including a shared mount. This records
            its location without copying the source directory.
          </Text>
          <View style={ROW}>
            {ui.button(
              "Save skill mapping",
              () => {
                void hub.run(mapSkill);
              },
              !mappedPath.trim() ||
                hub.target === skillOrigin.serverId ||
                hub.targetHost?.status !== "online",
            )}
            {ui.button("Cancel mapping", () => setSkillOrigin(null))}
          </View>
        </View>
      ) : null}
      <View style={ui.card}>
        <Text style={ui.text}>Manage {hub.hostName(hub.target)}</Text>
        <HubTargetPicker hub={hub} ui={ui} />
        {ui.button("Reload resources", () => {
          void hub.run(hub.reloadResources);
        })}
        <Text style={ui.muted}>
          Resources keep their server ownership. Enabled MCP entries are applied to new supported
          agents; skill links use the original directories.
        </Text>
        {resources?.skills.map((skill) => (
          <View key={skill.id} style={ROW}>
            <Text style={ui.text}>
              {skill.id} · {skill.path}
            </Text>
            {ui.button(skill.enabled ? "Disable skill" : "Enable skill", () => {
              void hub.run(() => toggleSkill(skill.id));
            })}
          </View>
        ))}
        {resources?.mcp.map((mcp) => (
          <View key={mcp.id} style={ROW}>
            <Text style={ui.text}>
              {mcp.id} · {mcp.type}
            </Text>
            {ui.button(mcp.enabled ? "Disable MCP" : "Enable MCP", () => {
              void hub.run(() => toggleMcp(mcp.id));
            })}
          </View>
        ))}
        {!resources ? (
          <Text style={ui.muted}>
            Waiting for this server&apos;s settings. Reconnect or Reload resources.
          </Text>
        ) : null}
        {ui.field("Project folder for shared skills", hub.cwd, hub.setCwd)}
        <View style={ROW}>
          {(["claude", "codex", "cursor"] as const).map((provider) => (
            <View key={provider}>
              {ui.button(
                `Use skills in ${provider}`,
                () => {
                  void hub.run(() => applySkills(provider));
                },
                !hub.cwd || !resources,
              )}
            </View>
          ))}
        </View>
        {ui.button(advanced ? "Hide Advanced" : "Advanced · Add skill or MCP", () =>
          setAdvanced(!advanced),
        )}
        {advanced ? (
          <>
            {ui.field("Skill name", hub.skillName, hub.setSkillName)}
            {ui.field("Skill directory on selected server", hub.skillPath, hub.setSkillPath)}
            {ui.button(
              "Share skill",
              () => {
                void hub.run(addSkill);
              },
              !resources || !hub.skillName || !hub.skillPath,
            )}
            {ui.field("MCP name", hub.mcpName, hub.setMcpName)}
            <View style={ROW}>
              {ui.button("HTTP", () => setMcpType("http"), false, mcpType === "http")}
              {ui.button(
                "Local command (stdio)",
                () => setMcpType("stdio"),
                false,
                mcpType === "stdio",
              )}
            </View>
            {mcpType === "http" ? (
              ui.field("MCP HTTP URL", hub.mcpUrl, hub.setMcpUrl)
            ) : (
              <>
                {ui.field("MCP command on selected server", mcpCommand, setMcpCommand)}
                {ui.field("MCP arguments (JSON array)", mcpArgs, setMcpArgs)}
              </>
            )}
            {ui.button(
              "Share MCP",
              () => {
                void hub.run(addMcp);
              },
              !resources || !hub.mcpName || !(mcpType === "http" ? hub.mcpUrl : mcpCommand),
            )}
          </>
        ) : null}
      </View>
    </>
  );
}
