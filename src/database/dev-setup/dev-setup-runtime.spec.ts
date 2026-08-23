import { spawnSync } from 'node:child_process';
import { loadDevSetupConfig } from './dev-setup';
import { LocalDatabaseRuntime } from './dev-setup-runtime';

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));

const mockedSpawnSync = jest.mocked(spawnSync);

describe('LocalDatabaseRuntime', () => {
  afterEach(() => {
    mockedSpawnSync.mockReset();
  });

  it('starts an existing stopped container before inspecting its port', async () => {
    const commands: string[][] = [];
    let inspectCount = 0;

    mockedSpawnSync.mockImplementation((_command, args) => {
      const commandArgs = [...(args ?? [])].map(String);
      commands.push(commandArgs);

      if (commandArgs[0] === 'inspect') {
        inspectCount += 1;
        return result(inspectCount === 1 ? 'exited\n' : 'running\n');
      }
      if (commandArgs[0] === 'start') return result();
      if (commandArgs[0] === 'port') return result('0.0.0.0:5434\n');

      throw new Error(`Unexpected Docker command: ${commandArgs.join(' ')}`);
    });

    const config = loadDevSetupConfig({
      NODE_ENV: 'development',
      DB_HOST: '127.0.0.1',
      DB_PORT: '5434',
      DB_USERNAME: 'postgres',
      DB_PASSWORD: 'local-test-only',
      DB_NAME: 'ecommerce_dev',
    });

    await expect(
      new LocalDatabaseRuntime().startDatabase(config),
    ).resolves.toBeUndefined();

    expect(commands.map((args) => args[0])).toEqual([
      'inspect',
      'start',
      'inspect',
      'port',
    ]);
    expect(commands.some((args) => args[0] === 'compose')).toBe(false);
  });
});

function result(stdout = '', status = 0, stderr = '') {
  return {
    pid: 1,
    output: [],
    stdout,
    stderr,
    status,
    signal: null,
  } as never;
}
