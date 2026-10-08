import { buildDaemonWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { getDesktopHost } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { HostProfile } from "@/types/host-connection";

export async function desktopFileStreamUrl(
  profile: HostProfile | undefined,
  token: string,
  preview: boolean,
  activeConnectionId?: string | null,
): Promise<string | null> {
  if (!getDesktopHost()) return null;
  const connections = profile?.connections ?? [];
  const connection =
    connections.find((item) => item.id === activeConnectionId) ??
    connections.find((item) => item.id === profile?.preferredConnectionId) ??
    connections[0];
  if (!connection) return null;
  let target: Record<string, unknown> | null = null;
  if (connection.type === "remoteSsh")
    target = {
      transportType: "ssh",
      host: connection.host,
      sshPort: connection.sshPort,
      daemonPort: connection.daemonPort,
    };
  if (connection.type === "directSocket" || connection.type === "directPipe")
    target = {
      transportType: connection.type === "directSocket" ? "socket" : "pipe",
      transportPath: connection.path,
    };
  if (connection.type === "directTcp")
    target = {
      transportType: "tcp",
      endpoint: buildDaemonWebSocketUrl(connection.endpoint, {
        useTls: connection.useTls ?? false,
      }).replace(/^ws/u, "http"),
    };
  if (!target) return null;
  const result = await invokeDesktopCommand<{ url: string }>("familiar_file_stream", {
    target,
    token,
    preview,
  });
  return result.url;
}

export async function releaseDesktopFileStream(url: string): Promise<void> {
  if (url.startsWith("familiaragent:"))
    await invokeDesktopCommand("familiar_release_file_stream", { url });
}

export function mediaKind(path: string): "audio" | "video" | null {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(extension ?? "")) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"].includes(extension ?? "")) return "audio";
  return null;
}
