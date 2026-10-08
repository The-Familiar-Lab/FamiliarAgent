import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** First-run defaults only; later user configuration remains authoritative. */
export async function ensureFamiliarDefaults(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const config = {
    version: 1,
    daemon: { listen: "127.0.0.1:6786", relay: { enabled: false } },
    features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
  };
  try {
    await writeFile(path.join(home, "config.json"), JSON.stringify(config), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
