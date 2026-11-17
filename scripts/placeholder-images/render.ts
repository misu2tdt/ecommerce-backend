// Draws one placeholder: a soft gradient in the colour of the variant, the
// product name in a clean sans-serif and a small category label. The picture is
// an SVG turned into a JPEG by sharp, so the same item always gives the same
// bytes on one machine. The text uses the first sans-serif font the system has,
// so the exact glyph shapes (and so the bytes) can differ between systems.

import sharp from 'sharp';
import { gradientStops, readableTextColour } from './colours';
import type { PlaceholderItem } from './plan';

export const JPEG_QUALITY = 84;
const FONT_STACK =
  "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif";

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Greedy word wrap: no line is longer than `maxChars` unless a single word is.
export function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && `${current} ${word}`.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface TextOptions {
  x: number;
  y: number;
  size: number;
  colour: string;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  spacing?: number;
  opacity?: number;
}

function text(content: string, options: TextOptions): string {
  const { x, y, size, colour, weight = 400, anchor = 'start' } = options;
  return (
    `<text x="${x}" y="${y}" font-family="${FONT_STACK}" font-size="${size}" ` +
    `font-weight="${weight}" fill="${colour}" text-anchor="${anchor}" ` +
    `letter-spacing="${options.spacing ?? 0}" opacity="${options.opacity ?? 1}">` +
    `${escapeXml(content)}</text>`
  );
}

export function buildSvg(item: PlaceholderItem): string {
  const { width, height, colour } = item;
  const stops = gradientStops(colour.base);
  const product = item.kind === 'product';
  // The band of a two-tone product sits at the bottom fifth.
  const bandTop = colour.accent ? Math.round(height * 0.8) : height;
  const ink = readableTextColour(colour.base);
  const bandInk = colour.accent ? readableTextColour(colour.accent) : ink;
  const centre = width / 2;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${stops.from}"/><stop offset="1" stop-color="${stops.to}"/>` +
      `</linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#g)"/>`,
  ];
  if (colour.accent) {
    parts.push(
      `<rect y="${bandTop}" width="${width}" height="${height - bandTop}" fill="${colour.accent}"/>`,
    );
  }
  // A thin inner frame, like a catalog page.
  const inset = product ? 48 : 64;
  parts.push(
    `<rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${bandTop - inset * 2}" ` +
      `fill="none" stroke="${ink}" stroke-opacity="0.22" stroke-width="2"/>`,
  );

  if (product) {
    const lines = wrapText(item.title, 17).slice(0, 3);
    const lineHeight = 80;
    const firstLine = Math.round(
      height * 0.44 - ((lines.length - 1) * lineHeight) / 2,
    );
    parts.push(
      text(item.label.toUpperCase(), {
        x: inset + 40,
        y: inset + 80,
        size: 26,
        colour: ink,
        weight: 600,
        spacing: 6,
        opacity: 0.75,
      }),
    );
    lines.forEach((line, index) => {
      parts.push(
        text(line, {
          x: centre,
          y: firstLine + index * lineHeight,
          size: 66,
          colour: ink,
          weight: 600,
          anchor: 'middle',
        }),
      );
    });
    const ruleY = firstLine + (lines.length - 1) * lineHeight + 50;
    parts.push(
      `<line x1="${centre - 48}" y1="${ruleY}" x2="${centre + 48}" y2="${ruleY}" stroke="${ink}" stroke-opacity="0.5" stroke-width="3"/>`,
    );
    // The colour name: under the rule, or in the band of a two-tone product.
    parts.push(
      colour.accent
        ? text(item.caption, {
            x: centre,
            y: bandTop + Math.round((height - bandTop) / 2) + 12,
            size: 36,
            colour: bandInk,
            weight: 600,
            anchor: 'middle',
            spacing: 2,
          })
        : text(item.caption, {
            x: centre,
            y: ruleY + 64,
            size: 36,
            colour: ink,
            anchor: 'middle',
            spacing: 2,
            opacity: 0.85,
          }),
    );
    parts.push(
      text('VERVE STUDIO  -  PREVIEW IMAGE', {
        x: centre,
        y: (colour.accent ? bandTop : height) - inset - 28,
        size: 18,
        colour: ink,
        anchor: 'middle',
        spacing: 5,
        opacity: 0.5,
      }),
    );
  } else {
    const lines = wrapText(item.title, 22).slice(0, 2);
    const lineHeight = 110;
    const firstLine = Math.round(
      height * 0.47 - ((lines.length - 1) * lineHeight) / 2,
    );
    parts.push(
      text(item.label.toUpperCase(), {
        x: centre,
        y: firstLine - 120,
        size: 30,
        colour: ink,
        weight: 600,
        anchor: 'middle',
        spacing: 9,
        opacity: 0.7,
      }),
    );
    lines.forEach((line, index) => {
      parts.push(
        text(line, {
          x: centre,
          y: firstLine + index * lineHeight,
          size: 96,
          colour: ink,
          weight: 600,
          anchor: 'middle',
        }),
      );
    });
    const ruleY = firstLine + (lines.length - 1) * lineHeight + 56;
    parts.push(
      `<line x1="${centre - 60}" y1="${ruleY}" x2="${centre + 60}" y2="${ruleY}" stroke="${ink}" stroke-opacity="0.5" stroke-width="3"/>`,
      ...wrapText(item.caption, 64)
        .slice(0, 2)
        .map((line, index) =>
          text(line, {
            x: centre,
            y: ruleY + 74 + index * 44,
            size: 32,
            colour: ink,
            anchor: 'middle',
            opacity: 0.8,
          }),
        ),
      text('VERVE STUDIO  -  PREVIEW IMAGE', {
        x: centre,
        y: height - inset - 28,
        size: 20,
        colour: ink,
        anchor: 'middle',
        spacing: 6,
        opacity: 0.5,
      }),
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

export async function renderPlaceholder(
  item: PlaceholderItem,
): Promise<Buffer> {
  return sharp(Buffer.from(buildSvg(item)))
    .jpeg({
      quality: JPEG_QUALITY,
      chromaSubsampling: '4:4:4',
      mozjpeg: false,
      progressive: false,
    })
    .toBuffer();
}
