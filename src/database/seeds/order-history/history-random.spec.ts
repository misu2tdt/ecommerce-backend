import { SeededRandom } from './history-random';

describe('SeededRandom', () => {
  it('gives the same sequence for the same seed and a different one for another', () => {
    const first = new SeededRandom(7);
    const second = new SeededRandom(7);
    const other = new SeededRandom(8);

    const a = Array.from({ length: 20 }, () => first.next());
    const b = Array.from({ length: 20 }, () => second.next());
    const c = Array.from({ length: 20 }, () => other.next());

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('int stays inside its inclusive range and reaches both ends', () => {
    const random = new SeededRandom(1);
    const seen = new Set<number>();
    for (let n = 0; n < 500; n += 1) seen.add(random.int(3, 6));

    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    expect(() => random.int(5, 4)).toThrow(RangeError);
    expect(() => random.int(1.5, 3)).toThrow(RangeError);
  });

  it('weighted choice follows the weights and never picks a zero weight', () => {
    const random = new SeededRandom(2);
    const counts = [0, 0, 0];
    for (let n = 0; n < 6000; n += 1)
      counts[random.weightedIndex([1, 0, 3])] += 1;

    expect(counts[1]).toBe(0);
    expect(counts[2] / counts[0]).toBeGreaterThan(2.5);
    expect(counts[2] / counts[0]).toBeLessThan(3.5);
  });

  it('rejects empty or invalid weights', () => {
    const random = new SeededRandom(3);

    expect(() => random.weightedIndex([0, 0])).toThrow(RangeError);
    expect(() => random.weightedIndex([1, -1])).toThrow(RangeError);
    expect(() => random.weighted(['a'], [1, 2])).toThrow(RangeError);
    expect(() => random.pick([])).toThrow(RangeError);
  });

  it('shuffle returns a permutation and leaves its input alone', () => {
    const random = new SeededRandom(4);
    const input = [1, 2, 3, 4, 5, 6, 7, 8];

    const shuffled = random.shuffle(input);

    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort()).toEqual(input);
    expect(shuffled).not.toEqual(input);
  });
});
