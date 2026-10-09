import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

type AgentDetail = NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>;
type AgentLookupState =
  | { tag: "idle" }
  | { tag: "loading" }
  | { tag: "not_found"; message: string }
  | { tag: "error"; message: string };

export function useAgentDetailLookup(input: {
  serverId: string;
  agentId?: string;
  present: boolean;
  enabled: boolean;
  client: Pick<DaemonClient, "fetchAgent"> | null;
  onResolved: (result: AgentDetail) => void;
}) {
  const { serverId, agentId, present, enabled, client, onResolved } = input;
  const [state, setState] = useState<AgentLookupState>({ tag: "idle" });
  const generation = useRef(0);
  const retry = useCallback(() => setState({ tag: "idle" }), []);
  useEffect(() => {
    generation.current += 1;
    setState({ tag: "idle" });
    return () => {
      generation.current += 1;
    };
  }, [serverId, agentId]);
  useEffect(() => {
    if (!agentId) return;
    if (present) {
      if (state.tag !== "idle") setState({ tag: "idle" });
      return;
    }
    // A failure stays visible until an explicit Retry; connection renders must not replay it.
    if (!client || !enabled || state.tag !== "idle") return;
    setState({ tag: "loading" });
    const attempt = ++generation.current;
    void client
      .fetchAgent({ agentId })
      .then((result) => {
        if (attempt !== generation.current) return;
        if (!result) {
          setState({ tag: "not_found", message: `Agent not found: ${agentId}` });
          return;
        }
        onResolved(result);
        setState({ tag: "idle" });
        return;
      })
      .catch((error: unknown) => {
        if (attempt !== generation.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({
          tag: /agent not found|not found/i.test(message) ? "not_found" : "error",
          message,
        });
      });
  }, [agentId, present, enabled, client, onResolved, state.tag]);
  return { state, retry };
}
