import type { PluginHostSummary } from "@getpaseo/plugin/client";
import type { input, output } from "zod";
import type { listHistory } from "../shared/history.js";
import type { HistorySummary } from "../shared/history.js";

export interface HostedHistory extends HistorySummary {
  serverId: string;
  serverLabel: string;
}
type ListInput = input<typeof listHistory.input>;
type ListOutput = output<typeof listHistory.output>;
export async function loadHistoryFleet(
  hosts: readonly PluginHostSummary[],
  input: ListInput,
  request: (serverId: string, input: ListInput) => Promise<ListOutput>,
) {
  const pages = await Promise.all(
    hosts.map(async (host) => {
      if (host.status !== "online")
        return { host, error: "Disconnected. Reconnect to read its original conversations." };
      try {
        return { host, page: await request(host.serverId, input) };
      } catch (error) {
        return { host, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const entries: HostedHistory[] = [];
  const errors: string[] = [],
    warnings: string[] = [];
  let total = 0,
    running = false,
    imported = 0,
    skipped = 0,
    hasMore = false;
  for (const result of pages) {
    if (!result.page) {
      errors.push(`${result.host.label}: ${result.error}`);
      continue;
    }
    const { page, host } = result;
    entries.push(
      ...page.entries.map((entry) => ({
        ...entry,
        serverId: host.serverId,
        serverLabel: host.label,
      })),
    );
    total += page.total;
    running ||= page.job.running;
    imported += page.job.imported;
    skipped += page.job.skipped;
    hasMore ||= (input.offset ?? 0) + (input.limit ?? 50) < page.total;
    warnings.push(...page.job.errors.map((error) => `${host.label}: ${error}`));
  }
  entries.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.serverId.localeCompare(right.serverId) ||
      left.id.localeCompare(right.id),
  );
  return { entries, total, errors, hasMore, job: { running, imported, skipped, errors: warnings } };
}
