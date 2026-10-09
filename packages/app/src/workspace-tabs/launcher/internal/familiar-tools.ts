import { z } from "zod";
import { toolGuideSchema } from "@getpaseo/protocol/familiar-tools";
import { useFetchQuery } from "@/data/query";
import type { InstalledPlugin } from "@/plugins/types";

const CATALOG_FRESHNESS_MS = 30_000;
const launcherTools = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    guide: toolGuideSchema.optional(),
  }),
);

export async function readFamiliarTools(plugin: Pick<InstalledPlugin, "invoke">) {
  return launcherTools.parse(await plugin.invoke("tools.list", {}));
}

export function useFamiliarToolCatalog(plugin: InstalledPlugin | undefined) {
  const query = useFetchQuery(
    {
      queryKey: ["familiar-launcher-tools", plugin?.serverId],
      enabled: Boolean(plugin),
      dataShape: "list",
      staleTimeMs: CATALOG_FRESHNESS_MS,
      retry: false,
      queryFn: async () => {
        if (!plugin) throw new Error("Familiar Hub is unavailable on this server.");
        return readFamiliarTools(plugin);
      },
    },
    plugin?.queryClient,
  );
  // Do not retain another host's tools while its replacement catalog is loading.
  return {
    tools: query.isPlaceholderData ? [] : (query.data ?? []),
    error: query.error?.message,
    loading: query.isFetching,
    reload: () => {
      void query.refetch();
    },
  };
}
