// Concurrency check ("load test") for the ordering and payment guarantees.
//
//   npm run loadtest:concurrency
//
// It starts the compiled backend itself, against the isolated test database
// only, runs five scenarios, prints a Markdown summary and writes
// docs/load-test-results.md. See docs/concurrency-check.md.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { JwtService } from '@nestjs/jwt';
import type { DataSource } from 'typeorm';
import { UserRole } from '../../src/users/entities/user-role.enum';
import {
  DEFAULT_OUTPUT,
  parseArgs,
  UsageError,
  USAGE,
  type ParsedArgs,
} from './args';
import {
  buildBackendEnvironment,
  chooseBackendPort,
  isPortFree,
  REPOSITORY_ROOT,
  startBackend,
  type BackendHandle,
} from './backend';
import {
  cleanup,
  createDataSource,
  createFixtures,
  markersForLeftovers,
  markersForRun,
  one,
  postgresDeadlockCount,
  sameSnapshot,
  seededSnapshot,
  settledDeadlockCount,
  type CleanupResult,
  type SeededSnapshot,
} from './database';
import {
  assertConnectedToTestDatabase,
  assertSafeLoadTestEnvironment,
  UnsafeEnvironmentError,
  type LoadTestDatabaseConfig,
} from './guard';
import { Api } from './http';
import {
  formatReport,
  runPassed,
  standardChecks,
  unexpectedNotes,
  type MachineInfo,
  type RunReport,
  type ScenarioReport,
} from './report';
import {
  SCENARIOS,
  type ScenarioContext,
  type ScenarioDefinition,
} from './scenarios';

function log(message: string): void {
  console.error(`[loadtest] ${message}`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeMachine(postgresVersion: string): MachineInfo {
  const cpus = os.cpus();
  const postgres = /^PostgreSQL\s+[\d.]+/.exec(postgresVersion)?.[0];
  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus.length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    postgres: postgres ?? postgresVersion,
  };
}

async function runScenario(
  definition: ScenarioDefinition,
  context: ScenarioContext,
  backend: BackendHandle,
): Promise<ScenarioReport> {
  log(`Scenario ${definition.id}: ${definition.title}`);
  const mark = backend.mark();
  const deadlocksBefore = await postgresDeadlockCount(context.ds);
  const report: ScenarioReport = {
    id: definition.id,
    title: definition.title,
    proves: definition.proves,
    bursts: [],
    checks: [],
    notes: [],
  };

  try {
    const outcome = await definition.run(context);
    report.bursts = outcome.bursts;
    report.checks = outcome.checks;
    report.notes = outcome.notes;
  } catch (error) {
    report.setupError = describeError(error);
  }

  // PostgreSQL publishes its counters a moment after the work.
  const deadlocksAfter = await settledDeadlockCount(context.ds);
  const logged = backend.deadlockLinesSince(mark);
  const errors = backend.errorLinesSince(mark);
  const databaseDeadlocks = deadlocksAfter - deadlocksBefore;

  if (report.setupError === undefined) {
    report.checks.push(
      ...standardChecks(report.bursts),
      {
        label: 'No deadlock (40P01) in the backend output or in PostgreSQL',
        passed: logged.length === 0 && databaseDeadlocks === 0,
        detail: `${logged.length} in backend output, ${databaseDeadlocks} counted by pg_stat_database`,
      },
      {
        label: 'The backend logged no errors',
        passed: errors.length === 0,
        detail: `${errors.length} error lines`,
      },
    );
    report.notes.push(...unexpectedNotes(report.bursts));
    for (const line of [...logged, ...errors].slice(0, 3)) {
      report.notes.push(`Backend output: ${line.slice(0, 240)}`);
    }
  }
  return report;
}

async function connect(config: LoadTestDatabaseConfig): Promise<{
  ds: DataSource;
  postgresVersion: string;
}> {
  const ds = createDataSource(config);
  await ds.initialize();
  try {
    const identity = await one<{ database: string; version: string }>(
      ds,
      `SELECT current_database() AS "database", version() AS "version"`,
    );
    assertConnectedToTestDatabase({ database: identity.database });
    return { ds, postgresVersion: identity.version };
  } catch (error) {
    await ds.destroy();
    throw error;
  }
}

function printCleanup(result: CleanupResult): void {
  if (result.ok) {
    log(
      `Clean-up done: ${
        Object.entries(result.removed)
          .map(([name, count]) => `${name} ${count}`)
          .join(', ') || 'nothing to remove'
      }`,
    );
  } else {
    for (const problem of result.problems) log(`CLEAN-UP PROBLEM: ${problem}`);
  }
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (parsed.kind === 'help') {
    console.log(USAGE);
    return 0;
  }
  const { options } = parsed;

  let database: LoadTestDatabaseConfig;
  try {
    database = assertSafeLoadTestEnvironment(process.env);
  } catch (error) {
    if (error instanceof UnsafeEnvironmentError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  let connection: Awaited<ReturnType<typeof connect>>;
  try {
    connection = await connect(database);
  } catch (error) {
    console.error(
      error instanceof UnsafeEnvironmentError
        ? error.message
        : `Could not connect to the test database: ${describeError(error)}`,
    );
    return error instanceof UnsafeEnvironmentError ? 2 : 3;
  }
  const { ds, postgresVersion } = connection;

  if (options.cleanupLeftovers) {
    try {
      const result = await cleanup(ds, markersForLeftovers());
      printCleanup(result);
      return result.ok ? 0 : 3;
    } finally {
      await ds.destroy();
    }
  }

  const startedAt = new Date();
  const timer = performance.now();
  const runId = randomBytes(4).toString('hex');
  const markers = markersForRun(runId);
  log(`Run ${runId}. Rows it creates carry the marker "loadtest-${runId}".`);

  let backend: BackendHandle | undefined;
  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
    log('Interrupted: stopping the backend and cleaning up.');
    void backend?.stop();
  });

  const scenarios: ScenarioReport[] = [];
  let before: SeededSnapshot | null = null;
  let backendStopped = false;
  let cleanupResult: CleanupResult = { ok: true, removed: {}, problems: [] };
  let startFailure: string | undefined;

  try {
    before = await seededSnapshot(ds, markers);

    const jwtSecret = randomBytes(32).toString('hex');
    const jwt = new JwtService({ secret: jwtSecret });
    const port = await chooseBackendPort();
    log(
      `Starting the backend on 127.0.0.1:${port} (NODE_ENV=test, demo payments)`,
    );
    backend = await startBackend(
      buildBackendEnvironment(process.env, database, port, jwtSecret),
      port,
    );

    const context: ScenarioContext = {
      ds,
      api: new Api(backend.baseUrl),
      options,
      fixtures: createFixtures(ds, runId),
      runId,
      sign: (user) =>
        jwt.signAsync(
          { sub: user.id, email: user.email, role: UserRole.USER },
          { expiresIn: '1h' },
        ),
    };

    for (const definition of SCENARIOS) {
      if (!options.scenarios.includes(definition.id) || interrupted) continue;
      scenarios.push(await runScenario(definition, context, backend));
    }
  } catch (error) {
    startFailure = describeError(error);
    log(`The run could not complete: ${startFailure}`);
  } finally {
    if (backend) {
      await backend.stop();
      backendStopped = await isPortFree(backend.port);
      if (!backendStopped) log(`Port ${backend.port} is still in use.`);
    } else {
      backendStopped = true;
    }
    cleanupResult = await cleanup(ds, markers);
    printCleanup(cleanupResult);
  }

  let seededUnchanged: boolean | null = null;
  try {
    if (before) {
      seededUnchanged = sameSnapshot(before, await seededSnapshot(ds, markers));
    }
  } finally {
    await ds.destroy();
  }

  const report: RunReport = {
    startedAt: startedAt.toISOString(),
    durationMs: performance.now() - timer,
    machine: describeMachine(postgresVersion),
    options,
    scenarios,
    cleanup: {
      ...cleanupResult,
      seededRowsUnchanged: seededUnchanged,
      problems: [
        ...cleanupResult.problems,
        ...(startFailure ? [`The run did not complete: ${startFailure}`] : []),
        ...(seededUnchanged === false
          ? ['Seeded demo rows differ from before the run.']
          : []),
      ],
    },
    backendStopped,
  };

  const markdown = formatReport(report);
  console.log(markdown);

  const allScenarios = options.scenarios.length === SCENARIOS.length;
  if (options.output !== null) {
    if (!allScenarios && options.output === DEFAULT_OUTPUT) {
      log(
        `Only some scenarios ran, so ${DEFAULT_OUTPUT} was not overwritten. Pass --output to write a file.`,
      );
    } else if (startFailure !== undefined) {
      log('The run did not complete, so no results file was written.');
    } else {
      const target = path.resolve(REPOSITORY_ROOT, options.output);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${markdown}\n`, 'utf8');
      log(`Wrote ${path.relative(REPOSITORY_ROOT, target)}`);
    }
  }

  if (!cleanupResult.ok) return 3;
  if (startFailure !== undefined) return 3;
  return runPassed(report) && scenarios.length > 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(describeError(error));
    process.exitCode = 3;
  },
);
