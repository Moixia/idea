import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, resolve, dirname } from 'pathe';

import type { SlashCommandHost } from './dispatch';
import { formatErrorMessage } from '../utils/event-payload';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 18080;
const DEFAULT_CONTEXT_SIZE = 4096;
const LOCAL_PROVIDER_ID = 'local';

/** Standard locations probed in order. */
function localAssetCandidates(...segments: string[]): string[] {
  const candidates: string[] = [];

  try {
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    candidates.push(
      // Source tree: apps/kimi-code/src/tui/commands -> apps/kimi-code
      resolve(thisDir, '..', '..', '..', ...segments),
      // Built bundle: apps/kimi-code/dist -> apps/kimi-code
      resolve(thisDir, '..', ...segments),
    );
  } catch {
    // import.meta.url can be unavailable in some packaged runtimes.
  }

  candidates.push(
    // Monorepo development when launched from the repository root.
    resolve(process.cwd(), 'apps', 'kimi-code', ...segments),
    // Alongside the executable in the installed/native layout.
    resolve(dirname(process.execPath), ...segments),
  );

  return [...new Set(candidates)];
}

const BINARY_CANDIDATES = localAssetCandidates('llama', 'llama-server.exe');

const MODEL_CANDIDATES = localAssetCandidates('local-model', 'model.gguf');

// ---------------------------------------------------------------------------
// /enable_local — scan, configure, and activate
// ---------------------------------------------------------------------------

/**
 * Scan the filesystem for the llama-server binary. Returns the first path
 * that exists and is a file, or `null` when none is found.
 */
function findBinary(): string | null {
  for (const candidate of BINARY_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // skip inaccessible paths
    }
  }
  return null;
}

/**
 * Scan standard locations for a `.gguf` model file.
 * Returns the first match, or `null` when none is found.
 */
function findModel(): string | null {
  for (const candidate of MODEL_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // skip
    }
  }
  return null;
}

/**
 * Derive a short model identifier from a gguf file path.
 *
 * - `model.gguf`                  → `local-gguf`
 * - `Llama-3.1-8B-Instruct.gguf` → `llama-3.1-8b-instruct`
 * - `/path/to/custom.gguf`        → `custom`
 */
function modelIdFromPath(modelPath: string): string {
  const name = basename(modelPath, '.gguf').replace(/\.gguf$/i, '');
  if (name === 'model' || name.length === 0) return 'local-gguf';
  // Normalise: lowercase, strip non-alphanumeric runs, preserve dots
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'local-gguf';
}

export async function handleEnableLocalCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  // 1. Resolve the binary path
  const binaryPath = findBinary();
  if (binaryPath === null) {
    host.showError(
      'llama-server.exe not found. Please install llama.cpp binaries in ' +
        'apps/kimi-code/llama/ or alongside the Landa executable.',
    );
    return;
  }

  // 2. Resolve model path: argument overrides auto-detect
  const modelPath = args.trim() || findModel() || '';
  if (modelPath.length === 0 || !existsSync(modelPath)) {
    const hint = args.trim()
      ? `The specified path does not exist: "${args.trim()}"`
      : 'No .gguf model found in apps/kimi-code/local-model/.';
    host.showError(
      `${hint} Pass the model path as an argument: /enable_local /path/to/model.gguf`,
    );
    return;
  }

  // 3. Derive model alias from filename
  const modelShortId = modelIdFromPath(modelPath);
  const modelAlias = `${LOCAL_PROVIDER_ID}/${modelShortId}`;

  // 4. Build provider config
  const config = await host.harness.getConfig({ reload: true });

  config.providers[LOCAL_PROVIDER_ID] = {
    type: 'local',
    modelPath,
    port: DEFAULT_PORT,
    contextSize: DEFAULT_CONTEXT_SIZE,
  };

  // 5. Build model alias (if not already present)
  if (config.models === undefined) config.models = {};
  if (!(modelAlias in config.models)) {
    config.models[modelAlias] = {
      provider: LOCAL_PROVIDER_ID,
      model: modelShortId,
      maxContextSize: DEFAULT_CONTEXT_SIZE,
      capabilities: ['thinking', 'tool_use'],
      displayName: modelShortId,
    };
  }

  // 6. Persist
  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: modelAlias,
    defaultThinking: true,
  });

  try {
    if (host.session !== undefined) {
      await host.session.setModel(modelAlias);
      await host.session.setThinking('on');
    } else {
      await host.authFlow.activateModelAfterLogin(modelAlias, true);
    }
  } catch (error) {
    host.showError(
      `Local provider enabled, but failed to select ${modelAlias}: ${formatErrorMessage(error)}`,
    );
    return;
  }

  // 7. Refresh UI state so the new provider & model appear immediately.
  host.setAppState({
    availableProviders: config.providers,
    availableModels: config.models ?? {},
    model: modelAlias,
    thinking: true,
  });

  host.showStatus(
    `Local provider enabled and selected: ${modelAlias} (port ${DEFAULT_PORT}, thinking on).`,
  );
}

// ---------------------------------------------------------------------------
// /disable_local — tear down config and stop the server
// ---------------------------------------------------------------------------

export async function handleDisableLocalCommand(
  host: SlashCommandHost,
  _args: string,
): Promise<void> {
  // 1. Remove the provider entry from config
  const config = await host.harness.getConfig({ reload: true });

  const hadProvider = LOCAL_PROVIDER_ID in config.providers;
  if (!hadProvider) {
    host.showNotice('Local provider is not currently enabled.');
    return;
  }

  // Remove the provider
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete config.providers[LOCAL_PROVIDER_ID];

  // Remove any model aliases that point to the local provider
  if (config.models !== undefined) {
    for (const [alias, aliasConfig] of Object.entries(config.models)) {
      if (aliasConfig.provider === LOCAL_PROVIDER_ID) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete config.models[alias];
      }
    }
  }

  // 2. Persist
  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
  });

  // 3. If the local model was the active model, trigger a refresh
  const activeModel = host.state.appState.model;
  const wasActive = activeModel.startsWith(`${LOCAL_PROVIDER_ID}/`);
  if (wasActive) {
    await host.authFlow.refreshConfigAfterLogin();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    host.setAppState({
      availableProviders: config.providers,
      availableModels: config.models ?? {},
    });
  }

  host.showStatus('Local provider disabled.');
}
