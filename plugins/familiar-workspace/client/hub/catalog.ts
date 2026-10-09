import type { ToolEntry } from "../../shared/tool-catalog.js";
export function updateToolHost(
  items: { serverId: string; tool: ToolEntry }[],
  serverId: string,
  tools: ToolEntry[],
) {
  return [
    ...items.filter((item) => item.serverId !== serverId),
    ...tools.map((tool) => ({ serverId, tool })),
  ];
}
