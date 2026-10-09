import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { aiderAdapter } from "./aider.js";
import { gooseAdapter } from "./goose.js";
import { openrigAdapter } from "./openrig.js";
import { squadAdapter } from "./squad.js";
import { superharnessAdapter } from "./superharness.js";

export const NATIVE_TOOL_ADAPTERS: ToolActionAdapter[] = [
  aiderAdapter,
  gooseAdapter,
  openrigAdapter,
  squadAdapter,
  superharnessAdapter,
];
