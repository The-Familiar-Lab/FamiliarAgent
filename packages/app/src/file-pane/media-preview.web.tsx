import { useCallback, useEffect, useRef, useState } from "react";
import { useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { desktopFileStreamUrl, releaseDesktopFileStream, mediaKind } from "./desktop-stream";

export interface MediaPreviewProps {
  serverId: string;
  workspaceRoot: string;
  path: string;
}
const containerStyle = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  padding: 20,
  flexDirection: "column",
  justifyContent: "center",
  gap: 12,
} as const;
const mediaStyle = { width: "100%", maxHeight: "100%" } as const;

export function MediaPreview({ serverId, workspaceRoot, path }: MediaPreviewProps) {
  const profile = useHosts().find((host) => host.serverId === serverId);
  const activeConnectionId = useHostRuntimeSnapshot(serverId)?.activeConnectionId;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const active = useRetainedPanelActive();
  const media = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    if (!active) media.current?.pause();
  }, [active]);
  useEffect(() => {
    let disposed = false;
    let allocated: string | null = null;
    setUrl(null);
    setError(null);
    void (async () => {
      if (!client) throw new Error("Host disconnected. Reconnect and retry.");
      const result = await client.requestDownloadToken(workspaceRoot, path);
      if (!result.token || result.error) throw new Error(result.error ?? "Unable to open file");
      allocated = await desktopFileStreamUrl(profile, result.token, true, activeConnectionId);
      if (!allocated)
        throw new Error(
          "Open this preview in the FamiliarAgent desktop app using a local or SSH connection.",
        );
      if (disposed) {
        await releaseDesktopFileStream(allocated);
        return;
      }
      setUrl(allocated);
    })().catch((failure) => {
      if (!disposed)
        setError(failure instanceof Error ? failure.message : "Media could not be opened");
    });
    return () => {
      disposed = true;
      if (allocated) void releaseDesktopFileStream(allocated);
    };
  }, [client, profile, workspaceRoot, path, revision, activeConnectionId]);
  const setMedia = useCallback((element: HTMLMediaElement | null) => {
    media.current = element;
  }, []);
  const onPlaybackError = useCallback(
    () =>
      setError(
        "Playback failed. The codec may be unsupported, the connection lost, or the preview expired.",
      ),
    [],
  );
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const props = {
    src: url ?? undefined,
    controls: true,
    preload: "metadata",
    ref: setMedia,
    onError: onPlaybackError,
    style: mediaStyle,
  } as const;
  let content;
  if (error)
    content = (
      <>
        <p role="alert">{error}</p>
        <button type="button" onClick={retry}>
          Retry playback
        </button>
      </>
    );
  else if (!url) content = <p role="status">Opening media…</p>;
  else if (mediaKind(path) === "video") content = <video {...props} />;
  else content = <audio {...props} />;
  return <div style={containerStyle}>{content}</div>;
}
