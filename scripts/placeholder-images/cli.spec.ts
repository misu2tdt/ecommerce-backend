import { join, resolve } from 'node:path';
import { runPlaceholderCli } from './cli';
import { REPOSITORY_ROOT, defaultOutputDirectory } from './generate';

function setup(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ outDir: string; count: number; force: boolean }> = [];
  const dependencies = {
    env,
    io: {
      log: (line: string) => out.push(line),
      error: (line: string) => err.push(line),
    },
    generate: (options: {
      outDir: string;
      items: readonly unknown[];
      force: boolean;
    }) => {
      calls.push({
        outDir: options.outDir,
        count: options.items.length,
        force: options.force,
      });
      return Promise.resolve({ written: ['a.jpg'], skipped: [], bytes: 1 });
    },
  };
  return { out, err, calls, dependencies };
}

describe('images:placeholders command', () => {
  it('uses the default folder outside the repository when nothing is given', async () => {
    const { calls, out, dependencies } = setup();

    expect(await runPlaceholderCli([], dependencies)).toBe(0);

    expect(calls).toEqual([
      { outDir: defaultOutputDirectory(), count: 103, force: false },
    ]);
    expect(out.join('\n')).toContain('103 planned, 1 written');
    expect(out.join('\n')).toContain('images:upload -- --dir');
    expect(out.join('\n')).toContain('--catalog all --dry-run');
  });

  it('takes the folder from --out first, then from PLACEHOLDER_IMAGES_DIR', async () => {
    const elsewhere = resolve(REPOSITORY_ROOT, '..', 'somewhere-else');
    const fromEnv = setup({ PLACEHOLDER_IMAGES_DIR: elsewhere });
    await runPlaceholderCli([], fromEnv.dependencies);
    expect(fromEnv.calls[0].outDir).toBe(elsewhere);

    const fromArgument = setup({ PLACEHOLDER_IMAGES_DIR: elsewhere });
    const argument = join(REPOSITORY_ROOT, '..', 'from-argument');
    await runPlaceholderCli(['--out', argument], fromArgument.dependencies);
    expect(fromArgument.calls[0].outDir).toBe(resolve(argument));
  });

  it('passes --force and leaves out the brand banners with --no-brands', async () => {
    const { calls, dependencies } = setup();

    await runPlaceholderCli(['--force', '--no-brands'], dependencies);

    expect(calls[0]).toMatchObject({ force: true, count: 99 });
  });

  it('refuses a folder inside the repository and writes nothing', async () => {
    const { calls, err, dependencies } = setup();

    const code = await runPlaceholderCli(
      ['--out', join(REPOSITORY_ROOT, 'images')],
      dependencies,
    );

    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(err.join('\n')).toContain('Refusing to write into the repository');
  });

  it('exits with a usage error for an unknown argument or a missing folder', async () => {
    for (const argv of [['--bogus'], ['--out'], ['--out', '--force']]) {
      const { calls, err, dependencies } = setup();
      expect(await runPlaceholderCli(argv, dependencies)).toBe(2);
      expect(err.join('\n')).toContain('Usage:');
      expect(calls).toEqual([]);
    }
  });

  it('reports a failure and exits with 1', async () => {
    const { err, dependencies } = setup();

    const code = await runPlaceholderCli([], {
      ...dependencies,
      generate: () => Promise.reject(new Error('disk full')),
    });

    expect(code).toBe(1);
    expect(err).toEqual(['disk full']);
  });
});
