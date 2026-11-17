// Colours of the placeholder pictures. Every colour of the batch 1 catalog has
// an entry here, so a placeholder looks like the colour it stands for. A colour
// without an entry gets a neutral tone instead of an error.

import { createSlug } from '../../src/catalog/slug';

export interface PlaceholderColour {
  // The main colour of the picture (a soft gradient is built around it).
  base: string;
  // A second colour for two-tone products: it fills the lower band.
  accent?: string;
  // False when the name had no entry and the neutral tone was used.
  known: boolean;
}

export const NEUTRAL_TONE = '#d9d4cc';

// Muted tones that read as fabric, keyed by colour slug (the same slug the
// image file name uses).
const COLOURS: Readonly<Record<string, { base: string; accent?: string }>> = {
  black: { base: '#2b2b2d' },
  'faded-black': { base: '#4a4a4c' },
  'washed-black': { base: '#44464a' },
  charcoal: { base: '#3c3f44' },
  slate: { base: '#5c6770' },
  'heather-grey': { base: '#a6a8ab' },
  'grey-marl': { base: '#9a9c9f' },
  white: { base: '#f3f1ed' },
  cream: { base: '#efe6d4' },
  ivory: { base: '#f2ecdd' },
  ecru: { base: '#e4dac3' },
  natural: { base: '#e0d5bd' },
  oat: { base: '#d9cdb6' },
  oatmeal: { base: '#d6c9b0' },
  sand: { base: '#d8c7a5' },
  stone: { base: '#bdb6a9' },
  khaki: { base: '#bfae86' },
  tan: { base: '#b58f62' },
  camel: { base: '#b98a54' },
  fawn: { base: '#c3a27d' },
  brown: { base: '#6b4a35' },
  rust: { base: '#a4532f' },
  'signal-orange': { base: '#e0662b' },
  citrus: { base: '#cfc94f' },
  blush: { base: '#e6c3bd' },
  'rose-taupe': { base: '#b3908d' },
  mauve: { base: '#a8828f' },
  'deep-plum': { base: '#4e2a45' },
  navy: { base: '#1f2d4a' },
  indigo: { base: '#2f3f6b' },
  cobalt: { base: '#1f4fb0' },
  'dusty-blue': { base: '#8fa5b8' },
  'sky-blue': { base: '#a9c8e3' },
  'light-wash': { base: '#a7bdd4' },
  forest: { base: '#2d4a3a' },
  olive: { base: '#6b6b3a' },
  'dusty-olive': { base: '#7d8260' },
  sage: { base: '#9db09a' },
  // Two-tone products: the main colour first, the second one in the band.
  'cream-navy': { base: '#efe6d4', accent: '#1f2d4a' },
  'cream-forest': { base: '#efe6d4', accent: '#2d4a3a' },
};

export function resolvePlaceholderColour(
  colourName: string,
): PlaceholderColour {
  const entry = COLOURS[createSlug(colourName)];
  return entry
    ? { ...entry, known: true }
    : { base: NEUTRAL_TONE, known: false };
}

export function hasPlaceholderColour(colourName: string): boolean {
  return createSlug(colourName) in COLOURS;
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex([red, green, blue]: [number, number, number]): string {
  return `#${[red, green, blue]
    .map((part) => Math.round(part).toString(16).padStart(2, '0'))
    .join('')}`;
}

// `amount` of `towards` mixed into `hex` (0 keeps hex, 1 gives towards).
export function mixHex(hex: string, towards: string, amount: number): string {
  const from = parseHex(hex);
  const to = parseHex(towards);
  return toHex([
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ]);
}

// A barely visible light-to-dark slope, so the picture is not a flat block.
export function gradientStops(base: string): { from: string; to: string } {
  return {
    from: mixHex(base, '#ffffff', 0.08),
    to: mixHex(base, '#000000', 0.1),
  };
}

// WCAG relative luminance, 0 (black) to 1 (white).
export function relativeLuminance(hex: string): number {
  const [red, green, blue] = parseHex(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export const DARK_TEXT = '#1f1d1a';
export const LIGHT_TEXT = '#f6f3ee';

// WCAG contrast ratio of two colours, 1 (none) to 21 (black on white).
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

// Whichever of the two text colours reads better on the background (so a mid
// tone such as sage or tan gets the one with more contrast, not a fixed guess).
export function readableTextColour(background: string): string {
  return contrastRatio(DARK_TEXT, background) >=
    contrastRatio(LIGHT_TEXT, background)
    ? DARK_TEXT
    : LIGHT_TEXT;
}
