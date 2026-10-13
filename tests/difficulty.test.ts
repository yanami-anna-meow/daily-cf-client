import { describe, expect, it } from 'vitest';
import { matchesDifficulty, parseDifficultyRange } from '../shared/difficulty';

describe('repository difficulty ranges', () => {
  it('includes unlabelled problems when neither bound is set', () => {
    const range = parseDifficultyRange(' ', '');
    expect(range).toEqual({ minimum: null, maximum: null, active: false, error: null });
    for (const rating of [null, 0, 800, 1750, 4000, 9999]) expect(matchesDifficulty(rating, range)).toBe(true);
  });

  it('includes both ends without rounding to the old difficulty bands', () => {
    const range = parseDifficultyRange('1451', '1999');
    expect([1450, 1451, 1499, 1901, 1999, 2000].map(rating => matchesDifficulty(rating, range)))
      .toEqual([false, true, true, true, true, false]);
    expect(matchesDifficulty(null, range)).toBe(false);
  });

  it.each([
    ['1700', '', [0, 1699, 1700, 4000, 9999], [false, false, true, true, true]],
    ['', '1700', [0, 1699, 1700, 1701, 9999], [true, true, true, false, false]],
    ['1700', '1700', [1699, 1700, 1701], [false, true, false]],
    ['0', '0', [0, 1], [true, false]],
    ['4001', '9999', [4000, 4001, 9999, 10000], [false, true, true, false]],
  ] as const)('accepts inclusive bounds %s to %s', (minimum, maximum, ratings, expected) => {
    const range = parseDifficultyRange(minimum, maximum);
    expect(range.error).toBeNull();
    expect(ratings.map(rating => matchesDifficulty(rating, range))).toEqual(expected);
    expect(matchesDifficulty(null, range)).toBe(false);
  });

  it('accepts surrounding whitespace and leading zeros without changing the range', () => {
    expect(parseDifficultyRange(' 001700 ', ' 2100 '))
      .toEqual({ minimum: 1700, maximum: 2100, active: true, error: null });
  });

  it('reports reversed bounds without silently swapping them or returning matches', () => {
    const range = parseDifficultyRange('2100', '1700');
    expect(range).toEqual({ minimum: 2100, maximum: 1700, active: true, error: '最低难度不能大于最高难度。' });
    expect(matchesDifficulty(1900, range)).toBe(false);
    expect(matchesDifficulty(null, range)).toBe(false);
  });

  it.each(['-1', '1.5', '1e3', '+1700', 'NaN', 'Infinity', 'abc', '9007199254740992'])
    ('rejects malformed or unsafe bound %s on either side', value => {
      const lower = parseDifficultyRange(value, '');
      const upper = parseDifficultyRange('', value);
      expect(lower.error).toContain('最低难度');
      expect(upper.error).toContain('最高难度');
      expect(matchesDifficulty(1700, lower)).toBe(false);
      expect(matchesDifficulty(1700, upper)).toBe(false);
    });

  it('clearing both fields also clears errors and restores unlabelled problems', () => {
    expect(parseDifficultyRange('2000', '1000').error).not.toBeNull();
    const cleared = parseDifficultyRange('', '');
    expect(cleared.error).toBeNull();
    expect(matchesDifficulty(null, cleared)).toBe(true);
  });
});
