import { useEffect, useMemo, useRef, useState } from "react";
import type { TerminalState } from "@getpaseo/protocol/messages";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  TerminalWebViewDetector,
  type TerminalWebView,
  type TerminalWebViewRegistry,
} from "./terminal-web-view";

export type OpenTerminalWebView = (
  view: TerminalWebView,
  browserId: string | undefined,
  signal: AbortSignal,
) => Promise<{ browserId: string; show: () => void }>;

export function useTerminalWebView(input: {
  terminalId: string;
  registry: TerminalWebViewRegistry;
  active: boolean;
  open?: OpenTerminalWebView;
}) {
  const { terminalId, registry, active, open } = input;
  const detector = useMemo(() => new TerminalWebViewDetector(), []);
  const [view, setView] = useState<TerminalWebView | null>(() => registry.get(terminalId));
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const pendingUrl = useRef<string | null>(null);
  useEffect(() => {
    detector.reset();
    setView(registry.get(terminalId));
    setError(null);
    setOpening(false);
    return () => {
      if (pending.current && pendingUrl.current) registry.retry(terminalId, pendingUrl.current);
      pending.current?.abort();
      pending.current = null;
    };
  }, [registry, terminalId, detector]);
  const observe = (next: TerminalWebView | null) => {
    if (!next) return;
    if (registry.get(terminalId)?.url !== next.url) {
      pending.current?.abort();
      pending.current = null;
      setOpening(false);
      setError(null);
    }
    registry.observe(terminalId, next);
    setView((previous) => (previous?.url === next.url ? previous : next));
  };
  const onOutput = useStableEvent((data: Uint8Array) => observe(detector.feed(data)));
  const onRestore = useStableEvent((data: Uint8Array) => {
    detector.reset();
    observe(detector.feed(data));
  });
  const onSnapshot = useStableEvent((state: TerminalState) => observe(detector.snapshot(state)));
  const onExit = useStableEvent(() => {
    pending.current?.abort();
    detector.reset();
    registry.clear(terminalId);
    setView(null);
    setError(null);
  });
  const openView = useStableEvent(async () => {
    const current = registry.get(terminalId);
    if (!open || !current || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    pendingUrl.current = current.url;
    setOpening(true);
    setError(null);
    try {
      const prepared = await open(current, registry.browserId(terminalId), controller.signal);
      if (!controller.signal.aborted) {
        // Record before changing focus: showing the browser can unmount this terminal.
        registry.opened(terminalId, current.url, prepared.browserId);
        prepared.show();
      }
    } catch {
      // Transport errors may contain the private URL. Keep it out of UI/logs.
      if (!controller.signal.aborted)
        setError(`Could not open ${current.title}. Check the server connection and try again.`);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setOpening(false);
      }
    }
  });
  useEffect(() => {
    if (!active && pending.current) {
      pending.current.abort();
      if (pendingUrl.current) registry.retry(terminalId, pendingUrl.current);
      pending.current = null;
      setOpening(false);
    }
    if (
      active &&
      open &&
      view &&
      !opening &&
      registry.get(terminalId)?.url === view.url &&
      registry.claim(terminalId)
    )
      void openView();
  }, [active, open, view, registry, terminalId, openView, opening]);
  return {
    view,
    opening,
    error,
    openView,
    onOutput,
    onRestore,
    onSnapshot,
    onExit,
  };
}
