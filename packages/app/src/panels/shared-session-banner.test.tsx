// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedSessionBanner } from "./shared-session-banner";

interface FixtureAgent {
  labels: Record<string, string>;
}
interface FixtureSession {
  agents: Map<string, FixtureAgent>;
  agentDetails: Map<string, FixtureAgent>;
}
const fixture = vi.hoisted(() => ({ sessions: {} as Record<string, FixtureSession> }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: typeof fixture) => boolean) => selector(fixture),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: vi.fn(),
}));
vi.mock("@/stores/workspace-layout-store", () => ({
  useWorkspaceLayoutStore: { getState: () => ({ showExplorerSidebar: () => "explorer" }) },
}));

function session(labels: Record<string, string>): FixtureSession {
  return { agents: new Map([["agent/one", { labels }]]), agentDetails: new Map() };
}

describe("shared session banner", () => {
  beforeEach(() => {
    fixture.sessions = {};
    vi.mocked(navigateToWorkspace).mockClear();
  });
  afterEach(cleanup);

  it.each<Record<string, string>>([
    {},
    { "familiar.session": "old-validation-label" },
    { familiarSession: "session-only" },
    { familiarProject: "project-only" },
    { familiarSession: " ", familiarProject: "project" },
  ])("does not imply shared continuity for ordinary or incomplete labels: %j", (labels) => {
    fixture.sessions.local = session(labels);
    const view = render(
      <SharedSessionBanner serverId="local" workspaceId="workspace" agentId="agent/one" />,
    );
    expect(view.queryByTestId("shared-session-banner")).toBeNull();
    expect(view.getByRole("button", { name: "Open Familiar Hub" })).toBeTruthy();
    expect(navigateToWorkspace).not.toHaveBeenCalled();
  });

  it("opens the current agent's Hub on its own server, including after changing hosts", () => {
    const labels = { familiarSession: "logical-A", familiarProject: "project" };
    fixture.sessions["remote/host"] = session(labels);
    fixture.sessions.local = session(labels);
    const view = render(
      <SharedSessionBanner serverId="remote/host" workspaceId="workspace" agentId="agent/one" />,
    );
    expect(view.getByText("Shared session connected")).toBeTruthy();
    expect(
      view.getByText("Memory and earlier conversations are available to this agent."),
    ).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Open Familiar Hub" }));
    expect(navigateToWorkspace).toHaveBeenLastCalledWith({
      serverId: "remote/host",
      workspaceId: "workspace",
      target: {
        kind: "plugin",
        pluginId: "familiar-workspace",
        panelId: "shared",
        context: "workspace",
        params: { serverId: "remote/host", workspaceId: "workspace", agentId: "agent/one" },
      },
      placement: { mode: "pane", paneId: "explorer" },
    });
    view.rerender(
      <SharedSessionBanner serverId="local" workspaceId="workspace" agentId="agent/one" />,
    );
    fireEvent.click(view.getByRole("button", { name: "Open Familiar Hub" }));
    expect(navigateToWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        serverId: "local",
        target: expect.objectContaining({
          params: { serverId: "local", workspaceId: "workspace", agentId: "agent/one" },
        }),
      }),
    );
  });

  it("does not borrow labels from another server or another agent", () => {
    fixture.sessions.remote = session({ familiarSession: "session", familiarProject: "project" });
    const view = render(
      <SharedSessionBanner serverId="local" workspaceId="workspace" agentId="agent/one" />,
    );
    expect(view.queryByTestId("shared-session-banner")).toBeNull();
    view.rerender(
      <SharedSessionBanner serverId="remote" workspaceId="workspace" agentId="ordinary-agent" />,
    );
    expect(view.queryByTestId("shared-session-banner")).toBeNull();
  });
});
