import { Text } from "react-native";
export interface MediaPreviewProps {
  serverId: string;
  workspaceRoot: string;
  path: string;
}
export function MediaPreview(_props: MediaPreviewProps) {
  return <Text>Download this media to play it in your device’s media app.</Text>;
}
