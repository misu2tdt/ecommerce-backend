import { SeededRandom } from './history-random';
import { buildReviewText, sentimentForRating } from './review-text';

describe('review text', () => {
  const draws = (rating: number, count: number) => {
    const random = new SeededRandom(5 + rating);
    return Array.from({ length: count }, () => buildReviewText(random, rating));
  };

  it('maps ratings to a tone', () => {
    expect(sentimentForRating(5)).toBe('positive');
    expect(sentimentForRating(4)).toBe('positive');
    expect(sentimentForRating(3)).toBe('mixed');
    expect(sentimentForRating(2)).toBe('negative');
    expect(sentimentForRating(1)).toBe('negative');
  });

  it('always has a title within the column limit, and a body for most reviews', () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      const texts = draws(rating, 300);
      for (const text of texts) {
        expect(text.title.length).toBeGreaterThan(0);
        expect(text.title.length).toBeLessThanOrEqual(150);
        if (text.body !== null) expect(text.body.length).toBeLessThan(5000);
      }
      const withBody = texts.filter((text) => text.body !== null).length;
      expect(withBody / texts.length).toBeGreaterThan(0.8);
    }
  });

  it('is varied: many different bodies, not one phrase repeated', () => {
    const bodies = new Set(draws(5, 200).map((text) => text.body));

    expect(bodies.size).toBeGreaterThan(60);
  });

  it('is plain English: ASCII only, no emojis', () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      for (const text of draws(rating, 100)) {
        expect(`${text.title} ${text.body ?? ''}`).toMatch(/^[\x20-\x7e]*$/);
      }
    }
  });

  it('does not praise a low rating or complain about a high one', () => {
    expect(
      draws(1, 100).every(
        (text) => !/love it|perfect fit|would buy again/i.test(text.title),
      ),
    ).toBe(true);
    expect(
      draws(5, 100).every(
        (text) => !/disappointed|not what i hoped/i.test(text.title),
      ),
    ).toBe(true);
  });

  it('is the same for the same seed', () => {
    expect(draws(4, 20)).toEqual(draws(4, 20));
  });
});
