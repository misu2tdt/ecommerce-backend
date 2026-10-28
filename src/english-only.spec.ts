import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// Code point ranges of the letters used only by Vietnamese (accented Latin
// vowels, plus the d-with-stroke and horn letters). Kept as numbers so this
// file never matches itself. Comments, messages and logs are written in English.
const VIETNAMESE_CODE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0xc0, 0xc3],
  [0xc8, 0xca],
  [0xcc, 0xcd],
  [0xd2, 0xd5],
  [0xd9, 0xda],
  [0xdd, 0xdd],
  [0xe0, 0xe3],
  [0xe8, 0xea],
  [0xec, 0xed],
  [0xf2, 0xf5],
  [0xf9, 0xfa],
  [0xfd, 0xfd],
  [0x102, 0x103],
  [0x110, 0x111],
  [0x128, 0x129],
  [0x168, 0x169],
  [0x1a0, 0x1a1],
  [0x1af, 0x1b0],
  [0x1ea0, 0x1ef9],
];

function hasVietnameseLetter(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (
      VIETNAMESE_CODE_POINTS.some(([from, to]) => {
        return codePoint >= from && codePoint <= to;
      })
    ) {
      return true;
    }
  }
  return false;
}

// Legitimate Vietnamese data: slug handling of diacritics and demo names.
const ALLOWED_FILES = new Set([
  'src/catalog/slug.ts',
  'src/catalog/slug.spec.ts',
  'src/categories/categories.service.spec.ts',
  'src/brands/brands.service.spec.ts',
  'test/integration/catalog-foundation.integration-spec.ts',
]);

const repositoryRoot = resolve(__dirname, '..');

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('written text language', () => {
  it('keeps comments, messages and logs in English', () => {
    const offenders = ['src', 'test']
      .flatMap((directory) =>
        listTypeScriptFiles(join(repositoryRoot, directory)),
      )
      .map((file) => relative(repositoryRoot, file).replace(/\\/g, '/'))
      .filter((file) => !ALLOWED_FILES.has(file))
      .filter((file) =>
        hasVietnameseLetter(readFileSync(join(repositoryRoot, file), 'utf8')),
      );

    expect(offenders).toEqual([]);
  });
});
