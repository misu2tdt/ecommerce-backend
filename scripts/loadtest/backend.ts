// Starts the compiled backend (node dist/main) as a child process for the check
// and stops it again. Mirrors how the browser smoke harness starts it
// (ecommerce-frontend/tests/browser/support/backend-env.ts).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { EnvironmentVariables, LoadTestDatabaseConfig } from './guard';
import { sleep } from './http';

export const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
export const BACKEND_ENTRY = path.join(REPOSITORY_ROOT, 'dist', 'main.js');
const PREFERRED_PORT = 3000;
const READY_TIMEOUT_MS = 60_000;

/**
 * The environment of the child backend. Every setting that matters is set
 * explicitly, so nothing from a developer's shell or env files can point the
 * child at another database, a payment provider or Telegram.
 */
export function buildBackendEnvironment(
  base: EnvironmentVariables,
  database: LoadTestDatabaseConfig,
  port: number,
  jwtSecret: string,
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return {
    ...inherited,
    NODE_ENV: 'test',
    PORT: String(port),
    // Timestamps are stored without a zone: pin the process zone, as the smoke
    // harness does.
    TZ: 'UTC',
    DB_HOST: database.host,
    DB_PORT: String(database.port),
    DB_USERNAME: database.username,
    DB_PASSWORD: database.password,
    DB_NAME: database.database,
    // An empty value wins over any env file and disables the URL form.
    DATABASE_URL: '',
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: '1h',
    FRONTEND_ORIGIN: 'http://localhost:3001',
    SWAGGER_ENABLED: 'false',
    PAYMENT_PROVIDER: 'demo',
    // No order notification may leave this machine.
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    TELEGRAM_ADMIN_CHAT_ID: '',
  };
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

function askForFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.listen(0, '0.0.0.0');
  });
}

/** Port 3000 if it is free, otherwise any free port. */
export async function chooseBackendPort(): Promise<number> {
  return (await canListen(PREFERRED_PORT))
    ? PREFERRED_PORT
    : await askForFreePort();
}

export async function isPortFree(port: number): Promise<boolean> {
  return canListen(port);
}

export interface BackendMark {
  deadlockLines: number;
  errorLines: number;
}

export interface BackendHandle {
  port: number;
  baseUrl: string;
  mark(): BackendMark;
  deadlockLinesSince(mark: BackendMark): string[];
  errorLinesSince(mark: BackendMark): string[];
  /** The last lines of output, for a failure report. */
  tail(): string[];
  stop(): Promise<void>;
}

const DEADLOCK_PATTERN = /40P01|deadlock detected/i;
const ERROR_PATTERN = /\bERROR\b/;
const MAX_KEPT_LINES = 200;

export async function startBackend(
  environment: Record<string, string>,
  port: number,
): Promise<BackendHandle> {
  if (!existsSync(BACKEND_ENTRY)) {
    throw new Error(
      'dist/main.js not found. Build the backend first (npm run build).',
    );
  }

  const deadlockLines: string[] = [];
  const errorLines: string[] = [];
  const recent: string[] = [];
  const child: ChildProcess = spawn(process.execPath, [BACKEND_ENTRY], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let exited = false;
  let exitDescription = '';
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitDescription = `exit code ${code ?? 'none'}, signal ${signal ?? 'none'}`;
      resolve();
    });
  });

  const onLine = (line: string) => {
    if (line.trim().length === 0) return;
    recent.push(line);
    if (recent.length > MAX_KEPT_LINES) recent.shift();
    if (DEADLOCK_PATTERN.test(line)) deadlockLines.push(line);
    if (ERROR_PATTERN.test(line)) errorLines.push(line);
  };
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      lines.forEach(onLine);
    });
    stream?.on('end', () => {
      if (pending.length > 0) onLine(pending);
    });
  }

  const handle: BackendHandle = {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    mark: () => ({
      deadlockLines: deadlockLines.length,
      errorLines: errorLines.length,
    }),
    deadlockLinesSince: (mark) => deadlockLines.slice(mark.deadlockLines),
    errorLinesSince: (mark) => errorLines.slice(mark.errorLines),
    tail: () => [...recent],
    async stop() {
      if (exited) return;
      child.kill();
      await Promise.race([exitPromise, sleep(8000)]);
      if (!exited) {
        child.kill('SIGKILL');
        await Promise.race([exitPromise, sleep(4000)]);
      }
    },
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `The backend stopped while starting (${exitDescription}). Last output:\n${recent.slice(-15).join('\n')}`,
      );
    }
    try {
      const response = await fetch(`${handle.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return handle;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  await handle.stop();
  throw new Error(
    `The backend did not become healthy within ${READY_TIMEOUT_MS / 1000} s. Last output:\n${recent.slice(-15).join('\n')}`,
  );
}
