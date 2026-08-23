import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import {
  assertSafeDevSetup,
  DevSetupConfig,
  DevSetupDependencies,
  missingManagedDatabases,
} from './dev-setup';

const COMMAND_TIMEOUT_MS = 60_000;
const HEALTH_ATTEMPTS = 30;
const HEALTH_RETRY_MS = 1_000;

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface ContainerInfo {
  status: string;
  hostPorts: readonly number[];
}

export class LocalDatabaseRuntime implements DevSetupDependencies {
  startDatabase(config: DevSetupConfig): Promise<void> {
    assertSafeDevSetup(config);
    const existingStatus = this.inspectContainerStatus(config.containerName);

    if (existingStatus) {
      if (existingStatus !== 'running') {
        console.log(
          `Starting existing PostgreSQL container ${config.containerName}...`,
        );
        runCommand('docker', ['start', config.containerName], {
          inheritOutput: true,
        });
      } else {
        console.log(
          `Reusing running PostgreSQL container ${config.containerName}.`,
        );
      }

      const existing = this.inspectContainer(config.containerName);
      if (!existing || existing.status !== 'running') {
        throw new Error(
          `PostgreSQL container ${config.containerName} did not start`,
        );
      }
      this.assertContainerPort(existing, config);
      return Promise.resolve();
    }

    console.log(
      `Creating PostgreSQL container ${config.containerName} with Compose...`,
    );
    runCommand(
      'docker',
      [
        'compose',
        '--project-name',
        config.composeProject,
        '-f',
        join(process.cwd(), 'compose.dev.yaml'),
        'up',
        '-d',
        'postgres',
      ],
      { inheritOutput: true },
    );

    const created = this.inspectContainer(config.containerName);
    if (!created)
      throw new Error('Compose did not create the expected container');
    this.assertContainerPort(created, config);
    return Promise.resolve();
  }

  async waitForDatabase(config: DevSetupConfig): Promise<void> {
    assertSafeDevSetup(config);
    console.log(
      `Waiting for PostgreSQL on ${config.databaseHost}:${config.databasePort}...`,
    );

    for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
      const result = runCommand(
        'docker',
        [
          'exec',
          config.containerName,
          'pg_isready',
          '-U',
          config.databaseUsername,
          '-d',
          'postgres',
        ],
        { allowFailure: true, timeoutMs: 5_000 },
      );
      if (result.status === 0) {
        console.log('PostgreSQL is accepting connections.');
        return;
      }
      if (attempt < HEALTH_ATTEMPTS) await delay(HEALTH_RETRY_MS);
    }

    throw new Error(
      `PostgreSQL did not become ready after ${HEALTH_ATTEMPTS} attempts`,
    );
  }

  async ensureDatabases(config: DevSetupConfig): Promise<readonly string[]> {
    assertSafeDevSetup(config);
    const maintenance = new DataSource({
      type: 'postgres',
      host: config.databaseHost,
      port: config.databasePort,
      username: config.databaseUsername,
      password: config.databasePassword,
      database: 'postgres',
      synchronize: false,
      dropSchema: false,
      migrationsRun: false,
      entities: [],
    });

    await maintenance.initialize();
    try {
      const rows = await maintenance.query<Array<{ datname: string }>>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1)',
        [['ecommerce_dev', 'ecommerce_test']],
      );
      const missing = missingManagedDatabases(
        rows.map(({ datname }) => datname),
      );

      for (const database of missing) {
        // `database` comes exclusively from the fixed MANAGED_DATABASES allowlist.
        await maintenance.query(`CREATE DATABASE "${database}"`);
        console.log(`Created local database ${database}.`);
      }
      if (missing.length === 0) {
        console.log(
          'Local development and integration databases already exist.',
        );
      }
      return missing;
    } finally {
      await maintenance.destroy();
    }
  }

  runNpmScript(script: 'migration:run' | 'seed:demo'): Promise<void> {
    console.log(`Running npm script ${script}...`);
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath) {
      runCommand(process.execPath, [npmExecPath, 'run', script], {
        inheritOutput: true,
      });
      return Promise.resolve();
    }

    runCommand(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', script],
      {
        inheritOutput: true,
      },
    );
    return Promise.resolve();
  }

  stopDatabase(config: DevSetupConfig): Promise<void> {
    assertSafeDevSetup(config);
    const existing = this.inspectContainer(config.containerName);
    if (!existing) {
      console.log(
        `PostgreSQL container ${config.containerName} does not exist.`,
      );
      return Promise.resolve();
    }
    this.assertContainerPort(existing, config);
    if (existing.status !== 'running') {
      console.log(
        `PostgreSQL container ${config.containerName} is already stopped.`,
      );
      return Promise.resolve();
    }

    console.log(
      `Stopping ${config.containerName}; its container and volume are preserved...`,
    );
    runCommand('docker', ['stop', '--time', '10', config.containerName], {
      inheritOutput: true,
    });
    return Promise.resolve();
  }

  private inspectContainer(containerName: string): ContainerInfo | undefined {
    const status = this.inspectContainerStatus(containerName);
    if (!status) return undefined;

    const ports = runCommand('docker', ['port', containerName, '5432/tcp'], {
      allowFailure: true,
    });
    if (ports.status !== 0) {
      throw new Error(`Unable to inspect PostgreSQL port: ${safeError(ports)}`);
    }
    const hostPorts = ports.stdout
      .split(/\r?\n/)
      .map((line) => /:(\d+)$/.exec(line.trim())?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);

    return { status, hostPorts };
  }

  private inspectContainerStatus(containerName: string): string | undefined {
    const inspection = runCommand(
      'docker',
      ['inspect', '--format', '{{.State.Status}}', containerName],
      { allowFailure: true },
    );
    if (inspection.status !== 0) {
      if (/no such (object|container)/i.test(inspection.stderr))
        return undefined;
      throw new Error(
        `Unable to inspect Docker container: ${safeError(inspection)}`,
      );
    }
    return inspection.stdout.trim();
  }

  private assertContainerPort(
    container: ContainerInfo,
    config: DevSetupConfig,
  ): void {
    if (!container.hostPorts.includes(config.hostPort)) {
      throw new Error(
        `Container ${config.containerName} must publish PostgreSQL on local port ${config.hostPort}`,
      );
    }
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    allowFailure?: boolean;
    inheritOutput?: boolean;
    timeoutMs?: number;
  } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    shell: false,
    stdio: options.inheritOutput ? 'inherit' : 'pipe',
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
  const commandResult: CommandResult = {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };

  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (!options.allowFailure && commandResult.status !== 0) {
    throw new Error(`${command} failed with exit code ${commandResult.status}`);
  }
  return commandResult;
}

function safeError(result: CommandResult): string {
  return result.stderr.trim().split(/\r?\n/)[0] || `exit code ${result.status}`;
}
