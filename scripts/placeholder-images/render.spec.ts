import sharp from 'sharp';
import type { PlaceholderItem } from './plan';
import { buildPlaceholderPlan } from './plan';
import { buildSvg, escapeXml, renderPlaceholder, wrapText } from './render';

const plan = buildPlaceholderPlan();
const item = (fileName: string): PlaceholderItem => {
  const found = plan.find((candidate) => candidate.fileName === fileName);
  if (!found) throw new Error(`no ${fileName} in the plan`);
  return found;
};

describe('placeholder text helpers', () => {
  it('wraps words without breaking one, and never makes a long line', () => {
    expect(wrapText('Cuban Collar Linen Blend Shirt', 17)).toEqual([
      'Cuban Collar',
      'Linen Blend Shirt',
    ]);
    expect(wrapText('Tee', 17)).toEqual(['Tee']);
    expect(wrapText('', 17)).toEqual([]);
    expect(wrapText('Extraordinarilylongword here', 10)).toEqual([
      'Extraordinarilylongword',
      'here',
    ]);
    const tooLong: string[] = [];
    for (const entry of plan.filter(
      (candidate) => candidate.kind === 'product',
    )) {
      const lines = wrapText(entry.title, 17);
      if (lines.length > 3 || lines.some((line) => line.length > 19)) {
        tooLong.push(entry.title);
      }
    }
    expect(tooLong).toEqual([]);
  });

  it('escapes the characters an SVG would choke on', () => {
    expect(escapeXml(`Cinder & Oak <"x"> 'y'`)).toBe(
      'Cinder &amp; Oak &lt;&quot;x&quot;&gt; &apos;y&apos;',
    );
  });
});

describe('placeholder picture', () => {
  it('draws the title, category and colour, escaped, in the size of the item', () => {
    const svg = buildSvg(item('heritage-ringer-tee__cream-navy.jpg'));

    expect(svg).toContain('width="1024" height="1280"');
    expect(svg).toContain('Heritage Ringer');
    expect(svg).toContain('T-SHIRTS &amp; TOPS');
    expect(svg).toContain('Cream &amp; Navy');
    expect(svg).toContain('PREVIEW IMAGE');
    expect(svg).not.toMatch(/<text[^>]*>[^<]*&[^a#]/);
  });

  it('adds the band only for a two-tone product', () => {
    expect(buildSvg(item('heritage-ringer-tee__cream-navy.jpg'))).toContain(
      'fill="#1f2d4a"/>',
    );
    expect(
      buildSvg(item('studio-high-rise-leggings__black.jpg')),
    ).not.toContain('fill="#1f2d4a"');
  });

  it('makes a valid JPEG of the planned size', async () => {
    for (const name of [
      'studio-high-rise-leggings__black.jpg',
      'banner-collection-new-arrivals.jpg',
    ]) {
      const entry = item(name);
      const bytes = await renderPlaceholder(entry);
      const meta = await sharp(bytes).metadata();

      expect(meta.format).toBe('jpeg');
      expect([meta.width, meta.height]).toEqual([entry.width, entry.height]);
      expect(bytes.length).toBeGreaterThan(5_000);
      expect(bytes.length).toBeLessThan(500_000);
    }
  });

  it('gives the same bytes for the same item', async () => {
    const entry = item('cuban-collar-linen-blend-shirt__ecru.jpg');

    const first = await renderPlaceholder(entry);
    const second = await renderPlaceholder(entry);

    expect(first.equals(second)).toBe(true);
  });

  it('really uses the colour: two colours of one product differ, and the picture is that colour', async () => {
    const light = await renderPlaceholder(
      item('essential-slub-cotton-tee__white.jpg'),
    );
    const dark = await renderPlaceholder(
      item('essential-slub-cotton-tee__black.jpg'),
    );
    expect(light.equals(dark)).toBe(false);

    const corner = async (bytes: Buffer) =>
      sharp(bytes).extract({ left: 4, top: 4, width: 8, height: 8 }).stats();
    const lightStats = await corner(light);
    const darkStats = await corner(dark);
    expect(lightStats.channels[0].mean).toBeGreaterThan(200);
    expect(darkStats.channels[0].mean).toBeLessThan(80);
  });
});
