import { Text, View } from "react-native";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { ROW, HubTargetPicker, type HubUi } from "./ui.js";
import type { HubController, HubProps } from "./controller.js";
export function HubWorkspace({
  hub,
  ui,
  forResult = false,
}: {
  hub: HubController;
  ui: HubUi;
  props: HubProps;
  forResult?: boolean;
}) {
  const {
    navigation,
    tab,
    project,
    session,
    target,
    cwd,
    setCwd,
    title,
    setTitle,
    tools,
    toolId,
    setToolId,
    models,
    modelId,
    setModelId,
    thinking,
    setThinking,
    run,
    linkFolder,
    start,
  } = hub;
  const { muted, card, button, field } = ui;
  const targetPicker = <HubTargetPicker hub={hub} ui={ui} />;
  return forResult || tab === "Projects" || tab === "Sessions" ? (
    <View style={card}>
      <Text style={ui.sectionHeading}>Where to work</Text>
      {targetPicker}
      {field("Project folder on selected server", cwd, setCwd)}
      {field("Project / session name", title, setTitle)}
      {!forResult ? (
        <View style={ROW}>
          {button(
            project ? "Link folder" : "Create project",
            () => {
              void run(linkFolder);
            },
            !cwd,
          )}
          {project
            ? button(
                "Open files",
                () => {
                  void run(async () => {
                    const workspace = await getPaseoClient(target).workspaces.open({ cwd });
                    navigation?.openWorkspace({ serverId: target, workspaceId: workspace.id });
                  });
                },
                !cwd,
              )
            : null}
        </View>
      ) : null}
      <Text style={muted}>
        Link an existing folder on each server. Shared mounts such as JuiceFS can provide the same
        files without a project copy.
      </Text>
      <View style={ROW}>
        {tools
          .filter((item) => item.serverId === target && item.tool.nativeProvider)
          .map(({ tool }) => (
            <View key={tool.id}>
              {button(tool.name, () => setToolId(tool.id), !tool.installed, tool.id === toolId)}
            </View>
          ))}
      </View>
      <View style={ROW}>
        {models.map((model) => (
          <View key={model.id}>
            {button(
              model.label,
              () => {
                setModelId(model.id);
                setThinking(model.defaultThinkingOptionId ?? "");
              },
              false,
              modelId === model.id,
            )}
          </View>
        ))}
      </View>
      <View style={ROW}>
        {models
          .find((model) => model.id === modelId)
          ?.thinkingOptions?.map((option) => (
            <View key={option.id}>
              {button(option.label, () => setThinking(option.id), false, thinking === option.id)}
            </View>
          ))}
      </View>
      {session && !forResult ? (
        <View style={ROW}>
          {button(
            `Separate Git worktree: ${hub.separateWorktree ? "On" : "Off"}`,
            () => hub.setSeparateWorktree(!hub.separateWorktree),
            false,
            hub.separateWorktree,
          )}
        </View>
      ) : null}
      {!forResult ? (
        <View style={ROW}>
          {button(
            session ? "Switch tool & continue" : "Start session",
            () => {
              void run(() => start(false));
            },
            !cwd || !modelId,
          )}
          {session
            ? button(
                "Fork session here",
                () => {
                  void run(() => start(true));
                },
                !cwd || !modelId,
              )
            : null}
        </View>
      ) : null}
      {session && !forResult ? (
        <Text style={muted}>
          Switch keeps logical session {session.id}. Fork creates a branch referring to its parent
          revision; full history is not copied. Fork uses the selected existing folder unless
          Separate Git worktree is On. A separate worktree uses the repository default branch
          selected by the native workspace service and requires Git; use Off for a non-Git folder.
          Uncommitted changes remain in the original folder. Open files gives access to the
          workspace and Git tools.
        </Text>
      ) : null}
    </View>
  ) : null;
}
