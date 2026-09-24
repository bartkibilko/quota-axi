import { agyAdapter } from "./agy.js";
import { alibabaAdapter } from "./alibaba.js";
import { claudeAdapter } from "./claude.js";
import { commandCodeAdapter } from "./commandcode.js";
import {
  createCustomHttpAdapter,
  readCustomHttpProviderConfigs,
} from "./custom-http.js";
import { codexAdapter } from "./codex.js";
import { copilotAdapter } from "./copilot.js";
import { cursorAdapter } from "./cursor.js";
import { devinAdapter } from "./devin.js";
import { elevenLabsAdapter } from "./elevenlabs.js";
import { grokAdapter } from "./grok.js";
import { kimiAdapter } from "./kimi.js";
import { opencodeGoAdapter } from "./opencode-go.js";
import { minimaxAdapter } from "./minimax.js";
import { mimoAdapter } from "./mimo.js";
import { deepseekAdapter } from "./deepseek.js";
import { openrouterAdapter } from "./openrouter.js";
import { zaiAdapter } from "./zai.js";
import {
  type ProviderAdapter,
  type ProviderId,
  type StaticProviderId,
} from "../types.js";

export const PROVIDERS: Record<StaticProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  copilot: copilotAdapter,
  grok: grokAdapter,
  kimi: kimiAdapter,
  zai: zaiAdapter,
  agy: agyAdapter,
  alibaba: alibabaAdapter,
  "opencode-go": opencodeGoAdapter,
  commandcode: commandCodeAdapter,
  minimax: minimaxAdapter,
  mimo: mimoAdapter,
  deepseek: deepseekAdapter,
  openrouter: openrouterAdapter,
  elevenlabs: elevenLabsAdapter,
  devin: devinAdapter,
};

export function parseProviders(value: string | undefined): ProviderId[] {
  const registry = loadProviderAdapters();
  const providerIds = Object.keys(registry) as ProviderId[];
  if (!value) return providerIds;
  const providers = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = providers.find(
    (provider) => !isProviderId(provider, registry),
  );
  if (invalid) {
    throw new Error(`unsupported provider: ${invalid}`);
  }
  return [...new Set(providers)] as ProviderId[];
}

export function loadProviderAdapters(): Record<ProviderId, ProviderAdapter> {
  const configured = readCustomHttpProviderConfigs().map((config) =>
    createCustomHttpAdapter(config),
  );
  const registry: Record<string, ProviderAdapter> = { ...PROVIDERS };
  for (const adapter of configured) {
    if (registry[adapter.id]) {
      throw new Error(
        `custom HTTP provider duplicates provider id: ${adapter.id}`,
      );
    }
    registry[adapter.id] = adapter;
  }
  return registry as Record<ProviderId, ProviderAdapter>;
}

export function supportedProviderIds(): ProviderId[] {
  return Object.keys(loadProviderAdapters()) as ProviderId[];
}

function isProviderId(
  value: string,
  registry: Record<ProviderId, ProviderAdapter>,
): value is ProviderId {
  return Object.hasOwn(registry, value);
}
