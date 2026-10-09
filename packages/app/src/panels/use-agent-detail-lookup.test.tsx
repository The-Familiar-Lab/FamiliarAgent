// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentDetailLookup } from "./use-agent-detail-lookup";
afterEach(cleanup);

it("keeps a timeout visible across renders and retries only once after an explicit retry", async () => {
  const client = { fetchAgent: vi.fn().mockRejectedValue(new Error("Request timed out")) };
  const input = {
    serverId: "mac",
    agentId: "old-agent",
    client,
    present: false,
    enabled: true,
    onResolved: vi.fn(),
  };
  const { result, rerender } = renderHook((props) => useAgentDetailLookup(props), {
    initialProps: input,
  });
  await waitFor(() =>
    expect(result.current.state).toEqual({ tag: "error", message: "Request timed out" }),
  );
  rerender({ ...input });
  await act(async () => {
    await Promise.resolve();
  });
  expect(client.fetchAgent).toHaveBeenCalledTimes(1);
  expect(result.current.state.tag).toBe("error");
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.state.tag).toBe("error"));
  expect(client.fetchAgent).toHaveBeenCalledTimes(2);
});

it("shows missing native agents without a retry loop and drops a previous server's late failure", async () => {
  let rejectOld!: (error: Error) => void;
  const client = {
    fetchAgent: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValue(null),
  };
  const input = {
    serverId: "mac",
    agentId: "agent",
    client,
    present: false,
    enabled: true,
    onResolved: vi.fn(),
  };
  const { result, rerender } = renderHook((props) => useAgentDetailLookup(props), {
    initialProps: input,
  });
  rerender({ ...input, serverId: "linux" });
  await waitFor(() => expect(result.current.state.tag).toBe("not_found"));
  await act(async () => {
    rejectOld(new Error("Old server timed out"));
  });
  expect(result.current.state).toEqual({ tag: "not_found", message: "Agent not found: agent" });
  expect(client.fetchAgent).toHaveBeenCalledTimes(2);
});
