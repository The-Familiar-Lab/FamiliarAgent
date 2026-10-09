import { useCallback, useEffect, useState } from "react";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PaseoProviderModelsResult, PaseoProviderModesResult } from "@getpaseo/client";
import { readWithDeadline } from "../read-deadline.js";
import { setupModelSelection } from "./setup.js";

type Models = NonNullable<PaseoProviderModelsResult["models"]>;
type Modes = NonNullable<PaseoProviderModesResult["modes"]>;
interface Choices {
  identity: string;
  models: Models;
  modes: Modes;
  model: string;
  thinking: string;
  mode: string;
  error: string;
}
const EMPTY: Choices = {
  identity: "",
  models: [],
  modes: [],
  model: "",
  thinking: "",
  mode: "",
  error: "",
};
const OPTIONS_DEBOUNCE_MS = 200;

function refreshedChoices(
  previous: Choices,
  identity: string,
  models: Models,
  modes: Modes,
): Choices {
  const available = models.filter((item) => item.isSelectable !== false);
  const selected = setupModelSelection(available);
  const sameProvider = previous.identity === identity;
  const model =
    sameProvider && available.some((item) => item.id === previous.model)
      ? previous.model
      : selected.model;
  const definition = available.find((item) => item.id === model)!;
  const thinking =
    sameProvider &&
    (!previous.thinking ||
      definition.thinkingOptions?.some((item) => item.id === previous.thinking))
      ? previous.thinking
      : (definition.defaultThinkingOptionId ?? "");
  const mode = sameProvider && modes.some((item) => item.id === previous.mode) ? previous.mode : "";
  return { identity, models: available, modes, model, thinking, mode, error: "" };
}

/** Discovery is read-only, bounded and keyed by host/provider/folder; stale results cannot launch. */
export function useSetupOptions(server: string, provider: string, cwd: string) {
  const identity = JSON.stringify([server, provider, cwd]);
  const [choices, setChoices] = useState<Choices>(EMPTY);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!provider) return;
    let current = true;
    setLoading(true);
    async function discover() {
      try {
        const api = getPaseoClient(server);
        const options = cwd.trim() ? { cwd } : undefined;
        const [models, modes] = await readWithDeadline(
          Promise.all([
            api.providers.listModels(provider, options),
            api.providers.listModes(provider, options),
          ]),
          "Setup agent options",
        );
        if (!current) return;
        if (models.error || modes.error)
          throw new Error(models.error || modes.error || "Provider discovery failed");
        // Validate before React runs the state updater, so errors stay in this request boundary.
        setupModelSelection(models.models ?? []);
        setChoices((previous) =>
          refreshedChoices(previous, identity, models.models ?? [], modes.modes ?? []),
        );
      } catch (error) {
        if (current)
          setChoices({
            ...EMPTY,
            identity,
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (current) setLoading(false);
      }
    }
    const timer = setTimeout(() => {
      void discover();
    }, OPTIONS_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [server, provider, cwd, identity, attempt]);
  const selectModel = useCallback(
    (model: string) =>
      setChoices((previous) => {
        const definition = previous.models.find((item) => item.id === model);
        return definition
          ? { ...previous, model, thinking: definition.defaultThinkingOptionId ?? "" }
          : previous;
      }),
    [],
  );
  const selectThinking = useCallback(
    (thinking: string) => setChoices((previous) => ({ ...previous, thinking })),
    [],
  );
  const selectMode = useCallback(
    (mode: string) => setChoices((previous) => ({ ...previous, mode })),
    [],
  );
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const active = choices.identity === identity ? choices : EMPTY;
  return {
    ...active,
    loading: !!provider && (loading || active === EMPTY),
    selectModel,
    selectThinking,
    selectMode,
    retry,
  };
}
