import { BATCH1_PRODUCTS } from '../../src/database/seeds/catalog-expansion/batch1.data';
import {
  DARK_TEXT,
  LIGHT_TEXT,
  NEUTRAL_TONE,
  contrastRatio,
  gradientStops,
  hasPlaceholderColour,
  mixHex,
  readableTextColour,
  relativeLuminance,
  resolvePlaceholderColour,
} from './colours';

describe('placeholder colours', () => {
  const batchColourNames = [
    ...new Set(
      BATCH1_PRODUCTS.flatMap((product) =>
        product.colours.map((colour) => colour.name),
      ),
    ),
  ];

  it('has a colour for every colour name of batch 1, so none falls back', () => {
    expect(batchColourNames.length).toBeGreaterThan(30);
    expect(
      batchColourNames.filter((name) => !hasPlaceholderColour(name)),
    ).toEqual([]);
    for (const name of batchColourNames) {
      expect(resolvePlaceholderColour(name).known).toBe(true);
    }
  });

  it('gives only #rrggbb values', () => {
    for (const name of batchColourNames) {
      const { base, accent } = resolvePlaceholderColour(name);
      expect(base).toMatch(/^#[0-9a-f]{6}$/);
      if (accent) expect(accent).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('finds a colour by its name however it is written', () => {
    expect(resolvePlaceholderColour('Dusty Olive')).toEqual(
      resolvePlaceholderColour('dusty olive'),
    );
    expect(resolvePlaceholderColour('Dusty Olive').base).toBe('#7d8260');
  });

  it('falls back to a neutral tone for a name it does not know', () => {
    expect(resolvePlaceholderColour('Electric Magenta')).toEqual({
      base: NEUTRAL_TONE,
      known: false,
    });
    expect(hasPlaceholderColour('Electric Magenta')).toBe(false);
  });

  it('gives the two-tone products a second colour for the band', () => {
    expect(resolvePlaceholderColour('Cream & Navy')).toMatchObject({
      base: '#efe6d4',
      accent: '#1f2d4a',
    });
    expect(resolvePlaceholderColour('Cream & Forest').accent).toBe('#2d4a3a');
    expect(resolvePlaceholderColour('Black').accent).toBeUndefined();
  });

  it('keeps the black variants apart from each other', () => {
    const blacks = ['Black', 'Faded Black', 'Washed Black'].map(
      (name) => resolvePlaceholderColour(name).base,
    );
    expect(new Set(blacks).size).toBe(3);
  });

  it('mixes colours towards white and black', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#336699', '#ffffff', 0)).toBe('#336699');
    expect(mixHex('#336699', '#000000', 1)).toBe('#000000');
    expect(() => mixHex('blue', '#ffffff', 0.5)).toThrow('#rrggbb');
  });

  it('builds a gradient that is only a little lighter and darker than the colour', () => {
    const { from, to } = gradientStops('#808080');
    expect(relativeLuminance(from)).toBeGreaterThan(
      relativeLuminance('#808080'),
    );
    expect(relativeLuminance(to)).toBeLessThan(relativeLuminance('#808080'));
    expect(relativeLuminance(from) - relativeLuminance(to)).toBeLessThan(0.15);
  });

  it('measures contrast from 1 to 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#808080', '#808080')).toBe(1);
  });

  it('measures luminance from 0 to 1', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('picks dark text on light colours and light text on dark ones', () => {
    expect(readableTextColour('#f3f1ed')).toBe(DARK_TEXT);
    expect(readableTextColour('#efe6d4')).toBe(DARK_TEXT);
    expect(readableTextColour('#2b2b2d')).toBe(LIGHT_TEXT);
    expect(readableTextColour('#1f2d4a')).toBe(LIGHT_TEXT);
  });

  it('keeps the text readable on every colour of batch 1 (contrast of at least 3:1)', () => {
    const unreadable: string[] = [];
    for (const name of batchColourNames) {
      const { base, accent } = resolvePlaceholderColour(name);
      for (const background of [base, ...(accent ? [accent] : [])]) {
        if (contrastRatio(readableTextColour(background), background) < 3) {
          unreadable.push(`${name} ${background}`);
        }
      }
    }
    expect(unreadable).toEqual([]);
  });
});
