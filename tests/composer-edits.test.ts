import { describe, expect, it, vi } from 'vitest';
import type { Problem, ProblemDay, SubmissionInput } from '../shared/types';
import { refreshComposerEntries } from '../src/components/BatchComposer';

vi.mock('../src/bridge', () => ({ api: {} }));

const problem: Problem = { id: 'cf4a', label: 'Old metadata', url: 'https://codeforces.com/problemset/problem/4/A', rating: 800, hint: 'Old hint' };
function entry(date = '2026-10-06') {
  return {
    key: 'stable-id', ordinal: 2, fileName: '', problem,
    input: { date, problemId: problem.id, language: 'cpp', author: '', code: '', notes: '' } as SubmissionInput,
  };
}
function day(problems: Problem[] = []): ProblemDay {
  return { date: '2026-10-06', problems, sourceUrl: 'https://github.com/example/problems', fetchedAt: '2026-10-08' };
}

describe('candidate refreshes preserve the submission queue', () => {
  it('updates matching problem metadata without replacing user inputs, identity or copies', () => {
    const first = entry();
    first.fileName = 'solution.cpp';
    first.input = { ...first.input, author: 'alice', code: 'int main() {}', notes: 'My notes', language: 'cpp', extension: 'cxx' };
    const second = { ...first, key: 'second-copy', ordinal: 3, input: { ...first.input, author: 'bob' } };
    const otherDate = entry('2035-01-01');
    const fresh = { ...problem, label: 'Fresh metadata', hint: 'Fresh hint' };
    const result = refreshComposerEntries([first, second, otherDate], day([fresh]));
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ ...first, problem: fresh, unavailable: false });
    expect(result[1]).toEqual({ ...second, problem: fresh, unavailable: false });
    expect(result[0].input).toBe(first.input);
    expect(result[1].input).toBe(second.input);
    expect(result[2]).toBe(otherDate);
  });

  it('keeps a removed problem and its uploaded code, then clears its warning if it returns', () => {
    const item = { ...entry(), fileName: 'solution.cpp', input: { ...entry().input, author: 'alice', code: 'source' } };
    const unavailable = refreshComposerEntries([item], day());
    expect(unavailable).toEqual([{ ...item, unavailable: true }]);
    expect(unavailable[0].input).toBe(item.input);
    const restored = refreshComposerEntries(unavailable, day([problem]));
    expect(restored).toEqual([{ ...item, unavailable: false }]);
    expect(restored[0].input).toBe(item.input);
  });

  it('leaves every queued item unchanged when browsing another date', () => {
    const item = entry('2030-02-01');
    const result = refreshComposerEntries([item], day([problem]));
    expect(result).toEqual([item]);
    expect(result[0]).toBe(item);
  });
});
