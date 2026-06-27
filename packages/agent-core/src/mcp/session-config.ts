import { stat } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import type { McpServerConfig } from '#/config/schema';

import { loadMcpServers } from './config-loader';

export interface SessionMcpConfig {
  readonly servers: Record<string, McpServerConfig>;
}

export interface ResolveSessionMcpConfigInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

export async function resolveSessionMcpConfig(
  input: ResolveSessionMcpConfigInput,
): Promise<SessionMcpConfig | undefined> {
  const servers = await loadMcpServers({
    cwd: input.cwd,
    homeDir: input.homeDir,
  });

  // ── Built-in lander MCP server ──────────────────────────────
  // Resolve app root directory from the entry script (normal Node) or
  // the executable itself (SEA), then try candidate locations for lander.exe.
  const appRoot = dirname(process.argv[1] ?? process.execPath);
  const candidates = [
    join(appRoot, 'lander.exe'),                              // alongside the executable
    join(appRoot, '..', 'lander', 'lander.exe'),               // apps/kimi-code/lander/ (dev)
  ];
  for (const landerPath of candidates) {
    try {
      await stat(landerPath);
      servers['lander'] = { command: landerPath, transport: 'stdio' };
      break;
    } catch {
      // try next candidate
    }
  }
  // ────────────────────────────────────────────────────────────

  if (Object.keys(servers).length === 0) return undefined;
  return { servers };
}

export function mergeCallerMcpServers(
  base: SessionMcpConfig | undefined,
  callerServers: Readonly<Record<string, McpServerConfig>> | undefined,
): SessionMcpConfig | undefined {
  if (callerServers === undefined || Object.keys(callerServers).length === 0) {
    return base;
  }
  return {
    servers: {
      ...base?.servers,
      ...callerServers,
    },
  };
}
