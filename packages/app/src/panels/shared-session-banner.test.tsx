// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import { router } from "expo-router";
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
  useWorkspaceLayoutStore: { getState: vi.fn() },
}));

function session(labels: Record<string, string>): FixtureSession {
  return { agents: new Map([["agent/one", { labels }]]), agentDetails: new Map() };
}

describe("shared session banner", () => {
  beforeEach(() => {
    fixture.sessions = {};
    vi.mocked(router.push).mockClear();
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
    expect(router.push).toHaveBeenLastCalledWith(
      "/h/remote%2Fhost/plugin/familiar-workspace/surface/main?param.agentId=agent%2Fone",
    );
    view.rerender(
      <SharedSessionBanner serverId="local" workspaceId="workspace" agentId="agent/one" />,
    );
    fireEvent.click(view.getByRole("button", { name: "Open Familiar Hub" }));
    expect(router.push).toHaveBeenLastCalledWith(
      "/h/local/plugin/familiar-workspace/surface/main?param.agentId=agent%2Fone",
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
