import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LLAMA_SERVER_DEFAULT_PORT = 18080;
export const LLAMA_SERVER_DEFAULT_CONTEXT_SIZE = 131_072;
export const LLAMA_SERVER_READY_TIMEOUT_MS = 180_000;
export const LLAMA_SERVER_HEALTH_POLL_MS = 500;

export interface LlamaServerOptions {
  /** Absolute path to the model.gguf file. */
  readonly modelPath: string;
  /** Server listen port (default 18080). */
  readonly port?: number;
  /** Context window size (default 131072). */
  readonly contextSize?: number;
  /** GPU layers to offload, 0 = CPU-only (default 0). */
  readonly gpuLayers?: number;
  /** Optional log callback so callers can forward messages to the TUI. */
  readonly onLog?: (message: string) => void;
  /**
   * Optional progress callback fired at each startup phase.
   * Use this to drive a progress spinner or status line in the TUI.
   */
  readonly onStep?: (step: string) => void;
}

/**
 * Resolve the path to `llama-server.exe`.
 *
 * Checks locations in this order:
 *  1. Relative to this source file (monorepo dev — uses `import.meta.url`).
 *  2. Alongside `process.execPath` (SEA / installed binary).
 *  3. Relative to `process.cwd()` (fallback for ad-hoc testing).
 *
 * Returns the first path that exists on disk, or `null` when none is found.
 */
export function resolveLlamaServerPath(): string | null {
  const candidates: string[] = [];

  // Candidate 1: derive the monorepo root from this module's own location
  // (reliable in dev mode where source files are on disk).
  try {
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    // thisDir = packages/kosong/src/local/ — go up 4 levels to reach the monorepo root
    candidates.push(
      resolve(thisDir, '..', '..', '..', '..', 'apps', 'kimi-code', 'llama', 'llama-server.exe'),
    );
  } catch {
    // import.meta.url may fail in a bundled SEA — skip silently.
  }

  // Candidate 2: alongside the SEA / installed executable
  try {
    candidates.push(
      resolve(dirname(process.execPath), 'llama', 'llama-server.exe'),
    );
  } catch {
    // process.execPath not available (shouldn't happen in Node).
  }

  // Candidate 3: fallback to cwd (works when running from the monorepo root
  // via tsx / jest, but NOT in production).
  try {
    candidates.push(
      resolve(process.cwd(), 'apps/kimi-code/llama/llama-server.exe'),
    );
  } catch {
    // cwd not available.
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // stat failed — skip this candidate
    }
  }

  return null;
}

// ---- Orphan-process cleanup -----------------------------------------------
// Track every spawned server PID so we can kill orphaned children when the
// parent process exits (crash, SIGTERM, or normal shutdown).

const spawnedPids = new Set<number>();

function registerOrphanCleanup(): void {
  // Only register once
  if ((registerOrphanCleanup as { _done?: boolean })._done) return;
  (registerOrphanCleanup as { _done?: boolean })._done = true;

  const killAll = (): void => {
    for (const pid of spawnedPids) {
      try {
        spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        // best-effort
      }
    }
    spawnedPids.clear();
  };

  process.on('exit', killAll);

  // On Windows SIGTERM is not sent to processes, but we register it anyway
  // for parity with POSIX environments (WSL, future macOS support).
  process.on('SIGTERM', () => {
    killAll();
    process.exit(0);
  });
}

/**
 * Manages the lifecycle of the `llama-server.exe` child process.
 *
 * This is a singleton: only one server instance runs per port. Obtain one
 * via {@link getInstance} / {@link start} and stop it via {@link stop}.
 * The process is spawned with `cwd` set to the directory containing the
 * binary so that the runtime DLLs (`ggml*.dll`, `llama*.dll`, …) are
 * resolved correctly on Windows.
 *
 * ### Orphan cleanup
 * Every spawned PID is tracked in a global set. When the Node.js process
 * exits (regardless of reason) the registered `exit` handler kills all
 * tracked PIDs with `taskkill /T /F` to prevent orphaned servers.
 */
export class LlamaServerProcess {
  private static readonly instances = new Map<number, LlamaServerProcess>();

  private child: ChildProcess | null = null;
  private serverPath: string | null = null;
  private _port: number;
  private _ready = false;
  private readonly recentLogs: string[] = [];
  private onLog?: (message: string) => void;
  private onStep?: (step: string) => void;

  /**
   * Get or create the singleton process for a given port.
   * Only one server per port can exist at a time.
   */
  static getInstance(port: number = LLAMA_SERVER_DEFAULT_PORT): LlamaServerProcess {
    let inst = LlamaServerProcess.instances.get(port);
    if (inst === undefined) {
      inst = new LlamaServerProcess(port);
      LlamaServerProcess.instances.set(port, inst);
    }
    return inst;
  }

  private constructor(port: number) {
    this._port = port;
  }

  /** The port the server is (or will be) listening on. */
  get port(): number {
    return this._port;
  }

  /** Whether the server process has started and passed the health check. */
  get ready(): boolean {
    return this._ready;
  }

  /** Whether the child process is currently alive. */
  get running(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }

  // ---- Public API -------------------------------------------------------

  /**
   * Start the `llama-server.exe` process.
   *
   * 1. Resolves the binary path via {@link resolveLlamaServerPath}.
   * 2. Spawns the process with the required arguments.
   * 3. Waits for the `/health` endpoint to respond OK.
   *
   * @throws when the binary is not found or the server fails to become ready.
   */
  async start(options: LlamaServerOptions): Promise<void> {
    if (this.running && this._ready) {
      this.log('Server already running and ready — skipping start.');
      return;
    }

    this.onLog = options.onLog;
    this.onStep = options.onStep;
    this.recentLogs.length = 0;

    // 1. Resolve binary
    this.step('Verifying llama-server binary...');
    const binaryPath = resolveLlamaServerPath();
    if (binaryPath === null) {
      throw new Error(
        'llama-server.exe not found.\n' +
          'Ensure the llama.cpp binaries are installed at:\n' +
          '  • apps/kimi-code/llama/llama-server.exe  (development)\n' +
          '  • alongside the Landa executable          (installed)\n' +
          'Run `/enable_local` again after placing the binary.',
      );
    }
    this.serverPath = binaryPath;

    // 2. Kill any leftover server on the same port (stale process from a crash)
    if (this.running) {
      this.log('A server instance is already running — stopping it first.');
      await this.killChild();
    }

    // 3. Sanity-check critical DLLs before spawning
    this.step('Checking required DLLs...');
    const binaryDir = dirname(binaryPath);
    const dllErrors = this.checkCriticalDlls(binaryDir);
    if (dllErrors.length > 0) {
      throw new Error(
        'Missing critical DLL' + (dllErrors.length > 1 ? 's' : '') +
        ` in ${binaryDir}:\n  • ${dllErrors.join('\n  • ')}\n` +
        'Reinstall the llama.cpp binaries.',
      );
    }

    // 4. Spawn
    this.step('Starting llama-server process...');
    const args = this.buildArgs(options);
    const stdio: Array<'pipe' | 'ignore'> = ['ignore', 'pipe', 'pipe'];

    this.log(`Starting llama-server on port ${this._port}...`);
    this.child = spawn(binaryPath, args, {
      cwd: binaryDir,
      stdio,
      windowsHide: true,
      detached: false,
      env: { ...process.env },
    });

    // Register PID for orphan cleanup
    if (this.child.pid !== undefined) {
      spawnedPids.add(this.child.pid);
      registerOrphanCleanup();
    }

    // 5. Wire stdout / stderr
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        this.log(`[llama-server] ${line}`);
      }
    });

    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        this.log(`[llama-server:err] ${line}`);
      }
    });

    // 6. Capture unexpected exits
    this.child.on('error', (err) => {
      this.log(`llama-server process error: ${err.message}`);
      this._ready = false;
    });

    this.child.on('exit', (code, signal) => {
      if (this.child?.pid !== undefined) {
        spawnedPids.delete(this.child.pid);
      }
      this.log(
        `llama-server exited (code=${code}, signal=${signal ?? 'none'})`,
      );
      this._ready = false;
      this.child = null;
    });

    // 7. Wait for readiness
    this.step('Loading model into memory (this may take a while)...');
    try {
      await this.waitForReady(options.modelPath);
    } catch (err) {
      // If the health-check fails, kill the child so we don't leave a broken
      // server process behind.
      await this.killChild();
      throw err;
    }
  }

  /**
   * Stop the server gracefully.
   *
   * Attempts `POST /shutdown` first, then falls back to SIGTERM and finally
   * `taskkill /T /F` on Windows.
   */
  async stop(): Promise<void> {
    // 1. Try graceful HTTP shutdown
    if (this._ready) {
      this.log('Requesting graceful shutdown via /shutdown...');
      try {
        const url = `http://127.0.0.1:${this._port}/shutdown`;
        await fetch(url, { method: 'POST', signal: AbortSignal.timeout(3000) });
        this.log('llama-server shutdown requested');
      } catch {
        this.log('HTTP shutdown failed — will kill process directly.');
      }
    }

    // 2. Kill the child process
    await this.killChild();

    // 3. Clean up singleton
    LlamaServerProcess.instances.delete(this._port);
    this._ready = false;
  }

  /**
   * Poll `GET /health` until the server responds OK.
   *
   * @param modelPath - Expected model path, used for log messages.
   * @param timeoutMs - Maximum time to wait (default 180s).
   */
  async waitForReady(
    modelPath?: string,
    timeoutMs: number = LLAMA_SERVER_READY_TIMEOUT_MS,
  ): Promise<void> {
    const healthUrl = `http://127.0.0.1:${this._port}/health`;
    const start = Date.now();
    let lastLoadingLog = 0;

    while (Date.now() - start < timeoutMs) {
      if (!this.running && !this._ready) {
        throw new Error(
          'llama-server exited before it became ready.\n' +
            this.formatRecentLogs(),
        );
      }

      try {
        const res = await fetch(healthUrl, {
          signal: AbortSignal.timeout(2000),
        });

        if (res.status === 200) {
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const status = String(body['status'] ?? '');
          const model = String(body['model'] ?? '');

          if (status === 'ok') {
            this.log(
              model.length > 0
                ? `llama-server ready (model: ${model})`
                : 'llama-server ready',
            );
            this._ready = true;
            return;
          }

          if (status === 'loading') {
            const elapsed = Math.round((Date.now() - start) / 1000);
            // Log every 15 seconds to avoid noise
            if (elapsed - lastLoadingLog >= 15) {
              this.log(`llama-server is still loading the model... (${elapsed}s)`);
              lastLoadingLog = elapsed;
            }
          }
        }
      } catch (err: unknown) {
        // ECONNREFUSED / connection reset — server not yet listening.
        // This is expected during startup. Silently retry.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ECONNREFUSED') || msg.includes('ERR_CONNECTION_REFUSED')) {
          // expected during startup
        } else if (msg.includes('TIMEOUT') || msg.includes('timeout')) {
          // expected if health endpoint is slow during model load
        } else {
          this.log(`Health check warning: ${msg}`);
        }
      }

      await sleep(LLAMA_SERVER_HEALTH_POLL_MS);
    }

    // Timeout reached
    const elapsed = Math.round((Date.now() - start) / 1000);
    throw new Error(
      `llama-server did not become ready within ${elapsed}s.\n` +
        (modelPath !== undefined
          ? `Model: "${modelPath}"\n` +
            'Possible causes:\n' +
            '  • The model file is too large for this machine\'s RAM.\n' +
            '  • The model file is corrupt or not a valid GGUF format.\n' +
            '  • Another process is already using port ' + this._port + '.\n' +
            'Try a smaller model or increase the timeout.'
          : ''),
    );
  }

  // ---- Internal ---------------------------------------------------------

  private step(label: string): void {
    this.onStep?.(label);
  }

  private buildArgs(options: LlamaServerOptions): string[] {
    const ctxSize = options.contextSize ?? LLAMA_SERVER_DEFAULT_CONTEXT_SIZE;
    const gpuLayers = options.gpuLayers ?? 0;
    const port = options.port ?? LLAMA_SERVER_DEFAULT_PORT;
    this._port = port;

    return [
      '-m', options.modelPath,
      '--port', String(port),
      '--host', '127.0.0.1',
      '-c', String(ctxSize),
      '-ngl', String(gpuLayers),
      '--no-ui',
      '--cont-batching',
      '-np', '1',
    ];
  }

  private checkCriticalDlls(binaryDir: string): string[] {
    // llama-server-impl.dll is the big one (9.5 MB); without it the process
    // exits with 126 / 127 immediately.  The other DLLs are transitively
    // loaded, but checking the two most distinctive ones catches most
    // installation issues early.
    const critical: Array<{ name: string; hint?: string }> = [
      { name: 'llama-server-impl.dll' },
      { name: 'ggml.dll' },
      { name: 'libomp140.x86_64.dll', hint: 'Install the Microsoft Visual C++ Redistributable if missing.' },
    ];
    const missing: string[] = [];
    for (const dll of critical) {
      if (!existsSync(resolve(binaryDir, dll.name))) {
        const hint = dll.hint !== undefined ? ` — ${dll.hint}` : '';
        missing.push(`${dll.name}${hint}`);
      }
    }
    return missing;
  }

  private async killChild(): Promise<void> {
    if (this.child === null || (this.child.killed && this.child.exitCode !== null)) return;

    const pid = this.child.pid;
    if (pid === undefined) return;

    // Remove from orphan tracker since we're cleaning up intentionally
    spawnedPids.delete(pid);

    return new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => {
        // Process did not exit gracefully — force kill.
        try {
          // Windows: use taskkill to terminate the tree
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.on('error', () => {});
        } catch {
          try {
            this.child?.kill('SIGTERM');
          } catch {}
        }
      }, 3000);

      this.child?.once('exit', () => {
        clearTimeout(timeout);
        this.child = null;
        resolvePromise();
      });

      // Try graceful termination first
      try {
        this.child?.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
  }

  private log(message: string): void {
    this.recentLogs.push(message);
    if (this.recentLogs.length > 40) this.recentLogs.shift();
    this.onLog?.(`[llama-server] ${message}`);
  }

  private formatRecentLogs(): string {
    if (this.recentLogs.length === 0) {
      return 'No llama-server output was captured.';
    }
    return `Recent llama-server output:\n${this.recentLogs.map((line) => `  ${line}`).join('\n')}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
