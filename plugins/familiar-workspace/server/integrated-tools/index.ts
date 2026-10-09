import { agentsAdapter } from "./agents.js";
import { aletheAdapter } from "./alethe.js";
import { codegAdapter } from "./codeg.js";
import { codeyAdapter } from "./codey.js";
import { hydraAdapter } from "./hydra.js";
import { openHarnessAdapter } from "./openharness.js";
import { orcaAdapter } from "./orca.js";
export {
  readIntegratedSetup,
  prepareIntegratedSetup,
  integratedActionDefaults,
  integratedInstallation,
} from "./setup.js";

export const INTEGRATED_TOOL_ADAPTERS = [
  orcaAdapter,
  hydraAdapter,
  codegAdapter,
  aletheAdapter,
  codeyAdapter,
  openHarnessAdapter,
  agentsAdapter,
];
