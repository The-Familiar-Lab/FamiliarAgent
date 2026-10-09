/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalWebViewRegistry } from "./terminal-web-view";
import { useTerminalWebView } from "./use-terminal-web-view";
const output = new TextEncoder().encode(
  "Pullboard view: http://127.0.0.1:43123/?k=test-private-key\r\n",
);

describe("terminal web view lifecycle", () => {
  it("opens when the terminal is selected, once across restore/remount, and can reopen explicitly", async () => {
    const registry = new TerminalWebViewRegistry();
    const open = vi.fn().mockResolvedValue({ browserId: "browser-one", show: vi.fn() });
    const hook = renderHook(
      ({ active }) => useTerminalWebView({ terminalId: "term", registry, active, open }),
      { initialProps: { active: false } },
    );
    act(() => hook.result.current.onRestore(output));
    expect(open).not.toHaveBeenCalled();
    hook.rerender({ active: true });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hook.result.current.opening).toBe(false));
    act(() => hook.result.current.onRestore(output));
    hook.unmount();
    const remounted = renderHook(() =>
      useTerminalWebView({ terminalId: "term", registry, active: true, open }),
    );
    expect(open).toHaveBeenCalledTimes(1);
    await act(() => remounted.result.current.openView());
    expect(open.mock.calls[1][1]).toBe("browser-one");
    act(() => remounted.result.current.onExit());
    expect(remounted.result.current.view).toBeNull();
  });
  it("shows a token-free retry error and does not loop on failure", async () => {
    const registry = new TerminalWebViewRegistry();
    const open = vi.fn().mockRejectedValue(new Error("secret URL test-private-key"));
    const hook = renderHook(() =>
      useTerminalWebView({ terminalId: "term", registry, active: true, open }),
    );
    act(() => hook.result.current.onOutput(output));
    await waitFor(() => expect(hook.result.current.error).toContain("try again"));
    expect(hook.result.current.error).not.toContain("test-private-key");
    act(() => hook.result.current.onRestore(output));
    expect(open).toHaveBeenCalledTimes(1);
    open.mockResolvedValue({ browserId: "browser", show: vi.fn() });
    await act(() => hook.result.current.openView());
    expect(hook.result.current.error).toBeNull();
  });
  it("cancels a pending navigation when the terminal unmounts", async () => {
    const registry = new TerminalWebViewRegistry();
    const open = vi.fn().mockImplementation(() => new Promise(() => {}));
    const hook = renderHook(() =>
      useTerminalWebView({ terminalId: "term", registry, active: true, open }),
    );
    act(() => hook.result.current.onOutput(output));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    hook.unmount();
    expect(open.mock.calls[0][2].aborted).toBe(true);
  });
  it("cancels a stale URL during SSH preparation and opens the new readiness address", async () => {
    const registry = new TerminalWebViewRegistry();
    const open = vi.fn().mockImplementation(() => new Promise(() => {}));
    const hook = renderHook(() =>
      useTerminalWebView({ terminalId: "term", registry, active: true, open }),
    );
    act(() => hook.result.current.onOutput(output));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const firstSignal = open.mock.calls[0][2];
    act(() =>
      hook.result.current.onOutput(
        new TextEncoder().encode("Pullboard view: http://127.0.0.1:43124/?k=new-test-key\r\n"),
      ),
    );
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    expect(open.mock.calls[1][0].url).toContain(":43124/");
  });
  it("does not steal focus after leaving a terminal while SSH prepares", async () => {
    const registry = new TerminalWebViewRegistry();
    const open = vi.fn().mockImplementation(() => new Promise(() => {}));
    const hook = renderHook(
      ({ active }) => useTerminalWebView({ terminalId: "term", registry, active, open }),
      { initialProps: { active: true } },
    );
    act(() => hook.result.current.onOutput(output));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const firstSignal = open.mock.calls[0][2];
    hook.rerender({ active: false });
    expect(firstSignal.aborted).toBe(true);
    hook.rerender({ active: true });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });
  it("records the opened browser before focus navigation can unmount the terminal", async () => {
    const registry = new TerminalWebViewRegistry();
    let unmount = () => {};
    const show = vi.fn(() => unmount());
    const open = vi.fn().mockResolvedValue({ browserId: "browser-one", show });
    const hook = renderHook(() =>
      useTerminalWebView({ terminalId: "term", registry, active: true, open }),
    );
    unmount = hook.unmount;
    act(() => hook.result.current.onOutput(output));
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(registry.browserId("term")).toBe("browser-one");
    const restored = renderHook(() =>
      useTerminalWebView({ terminalId: "term", registry, active: true, open }),
    );
    act(() => restored.result.current.onRestore(output));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
