// A small seeded pseudo-random generator (mulberry32). The same seed always gives
// the same sequence, which is what makes the order history reproducible: nothing
// in the history plan uses Math.random().
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  // A number in [0, 1).
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // A whole number from min to max, both included.
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`Invalid integer range ${min}..${max}`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Cannot pick from nothing');
    return items[Math.floor(this.next() * items.length)];
  }

  // The index of one weight, chosen in proportion to the weights.
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const weight of weights) {
      if (!(weight >= 0)) throw new RangeError('Weights must not be negative');
      total += weight;
    }
    if (total <= 0)
      throw new RangeError('At least one weight must be positive');
    let target = this.next() * total;
    for (let index = 0; index < weights.length; index += 1) {
      target -= weights[index];
      if (target < 0) return index;
    }
    return weights.length - 1;
  }

  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length !== weights.length) {
      throw new RangeError('Items and weights must have the same length');
    }
    return items[this.weightedIndex(weights)];
  }

  // A shuffled copy (Fisher-Yates); the input is not changed.
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.next() * (index + 1));
      [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
  }
}
