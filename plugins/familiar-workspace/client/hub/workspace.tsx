import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { ROW, HubDisclosure, HubPicker, HubTargetPicker, type HubUi } from "./ui.js";
import { ToolGuide } from "./tool-guide.js";
import type { HubController, HubProps } from "./controller.js";
const ACTIONS = { ...ROW, justifyContent: "flex-end" } as const;
interface Controls {
  hub: HubController;
  ui: HubUi;
}
function launchReady(hub: HubController): boolean {
  return hub.selectedTool?.nativeProvider
    ? !!hub.modelId
    : !!hub.selectedTool?.installed || hub.selectedTool?.launchSurface === "desktop";
}

function NativeModels({ hub, ui }: Controls) {
  const modelOptions = useMemo(
    () => hub.models.map((item) => ({ id: item.id, label: item.label })),
    [hub.models],
  );
  const thinkingOptions = useMemo(
    () => hub.models.find((item) => item.id === hub.modelId)?.thinkingOptions ?? [],
    [hub.models, hub.modelId],
  );
  const selectModel = useCallback(
    (id: string) => {
      hub.setModelId(id);
      hub.setThinking(hub.models.find((item) => item.id === id)?.defaultThinkingOptionId ?? "");
    },
    [hub],
  );
  return (
    <>
      <HubPicker
        label="Model"
        value={hub.modelId}
        options={modelOptions}
        onChange={selectModel}
        ui={ui}
      />
      {thinkingOptions.length ? (
        <HubPicker
          label="Thinking"
          value={hub.thinking}
          options={thinkingOptions}
          onChange={hub.setThinking}
          ui={ui}
        />
      ) : null}
    </>
  );
}
function WorkspaceAdvanced({ hub, ui, isFork }: Controls & { isFork: boolean }) {
  const openFiles = async () => {
    const workspace = await getPaseoClient(hub.target).workspaces.open({ cwd: hub.cwd });
    hub.navigation?.openWorkspace({ serverId: hub.target, workspaceId: workspace.id });
  };
  return (
    <HubDisclosure label="Advanced · name, folders & isolation" ui={ui}>
      {ui.field("Project / session name", hub.title, hub.setTitle)}
      <View style={ROW}>
        {ui.button(
          hub.project ? "Link folder" : "Create project",
          () => {
            void hub.run(hub.linkFolder);
          },
          !hub.cwd,
        )}
        {ui.button(
          "Open files",
          () => {
            void hub.run(openFiles);
          },
          !hub.cwd,
        )}
      </View>
      {isFork
        ? ui.button(
            `Separate Git worktree: ${hub.separateWorktree ? "On" : "Off"}`,
            () => hub.setSeparateWorktree(!hub.separateWorktree),
            false,
            hub.separateWorktree,
          )
        : null}
      <Text style={ui.muted}>
        Folder links do not copy files. Fork shares original history references and uses the
        selected folder. A separate Git worktree starts from the repository default branch;
        uncommitted files stay in the original folder.
      </Text>
    </HubDisclosure>
  );
}
function LaunchForm({
  hub,
  ui,
  forResult,
  isFork,
  close,
}: Controls & { forResult: boolean; isFork: boolean; close: () => void }) {
  const selected = hub.selectedTool;
  const options = useMemo(
    () =>
      hub.tools
        .filter(
          (item) =>
            item.serverId === hub.target &&
            (item.tool.nativeProvider ||
              item.tool.installed ||
              item.tool.launchSurface === "desktop"),
        )
        .map(({ tool }) => ({
          id: tool.id,
          label: `${tool.name}${tool.installed ? "" : " · setup needed"}`,
        })),
    [hub.tools, hub.target],
  );
  let label = hub.session ? "Switch tool & continue" : "Start session";
  if (isFork) label = "Fork session here";
  const launch = () => {
    if (selected?.nativeProvider) {
      void hub.run(() => hub.start(isFork));
      return;
    }
    if (selected)
      void hub.run(() => hub.launch(hub.target, selected, "launch", undefined, { fork: isFork }));
  };
  const ready = launchReady(hub);
  return (
    <>
      <HubTargetPicker hub={hub} ui={ui} />
      <HubPicker
        label="Tool"
        value={hub.toolId}
        options={options}
        onChange={hub.setToolId}
        ui={ui}
      />
      {selected ? <ToolGuide tool={selected} ui={ui} /> : null}
      {selected
        ? ui.button(selected.installed ? "Tool settings / Sign in" : "Set up this tool", () =>
            hub.openSetup(hub.target, selected.id),
          )
        : null}
      {selected?.nativeProvider ? <NativeModels hub={hub} ui={ui} /> : null}
      {ui.field("Project folder on selected server", hub.cwd, hub.setCwd)}
      {!forResult ? (
        <WorkspaceAdvanced hub={hub} ui={ui} isFork={isFork && !!selected?.nativeProvider} />
      ) : null}
      {!forResult ? (
        <View style={ACTIONS}>
          {ui.button("Cancel", close)}
          {ui.button(
            selected?.nativeProvider || isFork ? label : "Open original tool",
            launch,
            !hub.cwd || !ready,
            true,
          )}
        </View>
      ) : null}
    </>
  );
}
export function HubWorkspace({
  hub,
  ui,
  forResult = false,
}: Controls & { props: HubProps; forResult?: boolean }) {
  const [action, setAction] = useState<"continue" | "fork" | "new" | null>(null);
  useEffect(() => setAction(null), [hub.session?.id]);
  const close = useCallback(() => setAction(null), []);
  if (!forResult && hub.tab !== "Projects" && hub.tab !== "Sessions") return null;
  const active = hub.session?.endpoints.find((item) => item.id === hub.session?.activeEndpointId);

  let title = hub.project ? "Start in this project" : "Start something new";
  if (hub.session) title = "Continue your work";
  return (
    <View style={ui.card}>
      <Text style={ui.sectionHeading}>{title}</Text>
      {forResult || action ? (
        <LaunchForm
          hub={hub}
          ui={ui}
          forResult={forResult}
          isFork={action === "fork"}
          close={close}
        />
      ) : (
        <>
          <Text style={ui.muted}>
            {hub.session
              ? "Continue the same shared session with another tool, or branch it onto another server."
              : "Choose an existing session, or create a project using an existing folder."}
          </Text>
          <View style={ROW}>
            {active
              ? ui.button(
                  active.kind === "agent" ? "Open current conversation" : "Open current tool",
                  () => {
                    void hub.run(() => hub.openEndpoint(active, hub.session!.id));
                  },
                )
              : null}
            {ui.button(
              hub.session ? "Continue with another tool" : "New session",
              () => setAction(hub.session ? "continue" : "new"),
              false,
              true,
            )}
            {hub.session ? ui.button("Fork to another server", () => setAction("fork")) : null}
          </View>
        </>
      )}
    </View>
  );
}
