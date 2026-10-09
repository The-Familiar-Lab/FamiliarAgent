import { useCallback } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { settingsStyles } from "@/styles/settings";
interface Source {
  sshEndpoint: string;
  configPath: string;
}
interface Inventory {
  guild: { name: string };
  channels: { id: string; name: string }[];
}
const GAP = { gap: 8 };
function Choice({
  label,
  value,
  onSelect,
  disabled,
}: {
  label: string;
  value: string;
  onSelect(value: string): void;
  disabled: boolean;
}) {
  const select = useCallback(() => onSelect(value), [value, onSelect]);
  return (
    <Button variant="outline" disabled={disabled} onPress={select}>
      {label}
    </Button>
  );
}
export function DiscordSourceFields({
  source,
  inventory,
  servers,
  editing,
  revision,
  onSource,
  onInspect,
  onChannel,
}: {
  source?: Source;
  inventory: Inventory | null;
  servers: { label: string; endpoint: string }[];
  editing: boolean;
  revision: number;
  onSource(source?: Source): void;
  onInspect(createChannel: boolean): Promise<void>;
  onChannel(id: string): void;
}) {
  const existing = useCallback(
    () => onSource({ sshEndpoint: servers[0]?.endpoint ?? "", configPath: "" }),
    [onSource, servers],
  );
  const token = useCallback(() => onSource(undefined), [onSource]);
  const host = useCallback(
    (sshEndpoint: string) => onSource({ sshEndpoint, configPath: source?.configPath ?? "" }),
    [onSource, source],
  );
  const file = useCallback(
    (configPath: string) => onSource({ sshEndpoint: source?.sshEndpoint ?? "", configPath }),
    [onSource, source],
  );
  const load = useCallback(() => {
    void onInspect(false);
  }, [onInspect]);
  const create = useCallback(() => {
    void onInspect(true);
  }, [onInspect]);
  return (
    <View style={GAP}>
      <Text style={settingsStyles.rowTitle}>Bot connection</Text>
      <Button variant="outline" disabled={!editing} onPress={existing}>
        Use existing connector on a server
      </Button>
      <Button variant="outline" disabled={!editing} onPress={token}>
        Use a separate bot token
      </Button>
      {source ? (
        <>
          <Text style={settingsStyles.rowHint}>
            The token stays in its original private file. FamiliarAgent opens a separate connection
            for selected channels while this app is open. Your original bot and channels keep
            running.
          </Text>
          {servers.map((server) => (
            <Choice
              key={server.endpoint}
              label={server.label}
              value={server.endpoint}
              onSelect={host}
              disabled={!editing}
            />
          ))}
          <Field label="Connector server">
            <FormTextInput
              accessibilityLabel="Existing Discord connector server"
              initialValue={source.sshEndpoint}
              resetKey={`${revision}:${source.sshEndpoint}`}
              onChangeText={host}
              editable={editing}
              autoCapitalize="none"
            />
          </Field>
          <Field
            label="Original configuration file"
            hint="Absolute path to the existing .connect/config.json on that server. Nothing is copied or edited."
          >
            <FormTextInput
              accessibilityLabel="Original Discord connector configuration"
              initialValue={source.configPath}
              resetKey={revision}
              onChangeText={file}
              editable={editing}
              autoCapitalize="none"
            />
          </Field>
          <Button disabled={!editing || !source.sshEndpoint || !source.configPath} onPress={load}>
            Load Discord channels
          </Button>
          {inventory ? (
            <>
              <Text style={settingsStyles.rowTitle}>
                {inventory.guild.name} · choose a separate channel
              </Text>
              {inventory.channels.map((channel) => (
                <Choice
                  key={channel.id}
                  label={`#${channel.name}`}
                  value={channel.id}
                  onSelect={onChannel}
                  disabled={!editing}
                />
              ))}
              <Button variant="outline" disabled={!editing} onPress={create}>
                Create familiaragent-test channel
              </Button>
              <Text style={settingsStyles.rowHint}>
                The new channel is visible to the original allowed roles and the bot. Existing
                configured channels are excluded.
              </Text>
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
