import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import { Button } from "@/components/ui/button";

interface DirectoryEntry {
  name: string;
  kind: "file" | "directory";
}
export interface DirectoryBrowserClient {
  listDirectory: (cwd: string, path: string) => Promise<{ entries: DirectoryEntry[] }>;
}
const PAGE_SIZE = 100;

export function parentDirectory(value: string): string {
  const trimmed = value.replace(/\/+$/u, "");
  const separator = trimmed.lastIndexOf("/");
  return separator <= 0 ? "/" : trimmed.slice(0, separator);
}
export function childDirectory(parent: string, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\"))
    throw new Error("The server returned an invalid directory name.");
  return `${parent.replace(/\/+$/u, "")}/${name}`;
}

export function useDirectoryListing(client: DirectoryBrowserClient | null, path: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    client: DirectoryBrowserClient | null;
    path: string;
    entries: DirectoryEntry[];
    loading: boolean;
    error: string | null;
  }>({ client, path, entries: [], loading: true, error: null });
  useEffect(() => {
    let current = true;
    setState({ client, path, entries: [], loading: true, error: null });
    if (!client) {
      setState({ client, path, entries: [], loading: false, error: "This server is offline." });
      return;
    }
    void client.listDirectory(path, "").then(
      ({ entries }) => {
        if (current) setState({ client, path, entries, loading: false, error: null });
        return undefined;
      },
      (error: unknown) => {
        if (current)
          setState({
            client,
            path,
            entries: [],
            loading: false,
            error: error instanceof Error ? error.message : "Unable to read this directory.",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [client, path, revision]);
  return {
    ...state,
    current: state.client === client && state.path === path,
    retry: () => setRevision((value) => value + 1),
  };
}

/** Lists only the chosen server's current folder; selection performs no file mutation. */
export function DirectoryBrowser({
  client,
  serverName,
  initialPath = "/",
  onSelect,
  onClose,
}: {
  client: DirectoryBrowserClient | null;
  serverName: string;
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initialPath.startsWith("/") ? initialPath : "/");
  const [input, setInput] = useState(path);
  const [hidden, setHidden] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const listing = useDirectoryListing(client, path);
  const directories = useMemo(
    () =>
      listing.entries
        .filter((entry) => entry.kind === "directory" && (hidden || !entry.name.startsWith(".")))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [listing.entries, hidden],
  );
  const navigate = useCallback((value: string) => {
    setPath(value);
    setInput(value);
    setLimit(PAGE_SIZE);
  }, []);
  const up = useCallback(() => navigate(parentDirectory(path)), [navigate, path]);
  const go = useCallback(() => {
    if (input.trim().startsWith("/")) navigate(input.trim());
  }, [navigate, input]);
  const toggleHidden = useCallback(() => setHidden((value) => !value), []);
  const showMore = useCallback(() => setLimit((value) => value + PAGE_SIZE), []);
  const select = useCallback(() => onSelect(path), [onSelect, path]);
  const hiddenState = useMemo(() => ({ checked: hidden }), [hidden]);
  const ready = listing.current && !listing.loading && !listing.error;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.panel}>
          <Text style={styles.title}>Browse folders · {serverName}</Text>
          <View style={styles.row}>
            <Button variant="outline" onPress={up} disabled={path === "/"}>
              Up
            </Button>
            <TextInput
              accessibilityLabel="Directory path"
              key={path}
              initialValue={path}
              onChangeText={setInput}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={go}
            />
            <Button variant="outline" disabled={!input.trim().startsWith("/")} onPress={go}>
              Go
            </Button>
          </View>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={hiddenState}
            onPress={toggleHidden}
          >
            <Text style={styles.text}>{hidden ? "☑" : "☐"} Show hidden folders</Text>
          </Pressable>
          <ScrollView style={styles.list}>
            {listing.loading || !listing.current ? (
              <Text style={styles.text}>Loading folders…</Text>
            ) : null}
            {listing.current && listing.error ? (
              <View>
                <Text accessibilityRole="alert" style={styles.error}>
                  {listing.error}
                </Text>
                <Button variant="outline" onPress={listing.retry}>
                  Retry
                </Button>
              </View>
            ) : null}
            {ready
              ? directories
                  .slice(0, limit)
                  .map((entry) => (
                    <DirectoryRow
                      key={entry.name}
                      name={entry.name}
                      parent={path}
                      navigate={navigate}
                    />
                  ))
              : null}
            {ready && !directories.length ? (
              <Text style={styles.text}>No folders here.</Text>
            ) : null}
            {ready && directories.length > limit ? (
              <Button variant="outline" onPress={showMore}>
                Show more folders
              </Button>
            ) : null}
          </ScrollView>
          <Text style={styles.path}>{path}</Text>
          <View style={styles.row}>
            <Button variant="outline" onPress={onClose}>
              Cancel
            </Button>
            <Button disabled={!ready} onPress={select}>
              Select this folder
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}
function DirectoryRow({
  name,
  parent,
  navigate,
}: {
  name: string;
  parent: string;
  navigate: (path: string) => void;
}) {
  const open = useCallback(() => navigate(childDirectory(parent, name)), [navigate, parent, name]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open folder ${name}`}
      style={styles.folder}
      onPress={open}
    >
      <Text style={styles.text}>▸ {name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: 20,
  },
  panel: {
    width: 640,
    maxWidth: "100%",
    maxHeight: "85%",
    backgroundColor: theme.colors.surface0,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  title: { color: theme.colors.foreground, fontWeight: "600", fontSize: 18 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 6,
    padding: 8,
  },
  list: { minHeight: 180, maxHeight: 400 },
  folder: { paddingVertical: 10, paddingHorizontal: 6 },
  text: { color: theme.colors.foreground },
  path: { color: theme.colors.foregroundMuted, fontSize: 12 },
  error: { color: theme.colors.destructive },
}));
