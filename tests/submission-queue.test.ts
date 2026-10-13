import { describe, expect, it } from 'vitest';
import type { ProblemDay } from '../shared/types';
import { submissionPath } from '../shared/domain';
import { createQueueEntry, findQueueConflict, normalizeQueueEntry, putQueueEntry, queueEditorDirty, type SubmissionQueueEntry } from '../src/submissionQueue';

const day: ProblemDay = { date: '2030-01-02', sourceUrl: '', fetchedAt: '', problems: [{ id: 'cf4a', label: 'Watermelon', url: 'https://codeforces.com/problemset/problem/4/A', rating: 800, hint: '' }] };
function entry(key = 'first', author = 'alice'): SubmissionQueueEntry {
  const item = createQueueEntry(day, day.problems[0], 'cpp', [], key);
  return { ...item, fileName: 'local.cpp', input: { ...item.input, author, code: 'int main() {}\n' } };
}

describe('session submission list', () => {
  it('adds a normalized copy without mutating the source file or existing entries', () => {
    const old = entry();
    const incoming = entry('second', 'bob');
    incoming.input.code = '\uFEFFint main() {\r\n}\r\n';
    incoming.input.author = ' bob ';
    const list = Object.freeze([old]);
    const next = putQueueEntry(list, incoming);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(old);
    expect(next[1].input).toMatchObject({ author: 'bob', code: 'int main() {\n}\n' });
    expect(incoming.input.author).toBe(' bob ');
    expect(incoming.input.code).toContain('\r\n');
  });

  it('allows several authors on one problem and gives each editor its own identity', () => {
    const a = entry();
    const b = entry('second', 'bob');
    const incoming = createQueueEntry(day, day.problems[0], 'cpp', [a, { ...b, ordinal: 5 }], 'new');
    expect(incoming).toMatchObject({ key: 'new', ordinal: 6, input: { author: '', code: '' }, fileName: '' });
    expect(putQueueEntry([a], b)).toHaveLength(2);
  });

  it('detects the full repository path instead of just the problem or author', () => {
    const old = entry();
    const same = entry('second');
    same.input.author = ' alice ';
    expect(findQueueConflict([old], same)).toBe(old);
    expect(findQueueConflict([old], { ...same, input: { ...same.input, language: 'py', extension: 'py' } })).toBeUndefined();
    expect(findQueueConflict([old], { ...same, input: { ...same.input, date: '2040-02-03' } })).toBeUndefined();
    expect(findQueueConflict([old], { ...same, input: { ...same.input, problemId: 'cf4b' } })).toBeUndefined();
    expect(findQueueConflict([old], { ...same, input: { ...same.input, author: 'Alice' } })).toBeUndefined();
  });

  it('never silently replaces a same-path file, even if its code is identical', () => {
    const old = entry();
    const same = entry('second');
    expect(() => putQueueEntry([old], same)).toThrow('confirmation');
    expect(() => putQueueEntry([old], same, 'unrelated')).toThrow('confirmation');
    expect(old.key).toBe('first');
  });

  it('keeps C, C++ aliases and custom suffixes as different files for the same author and problem', () => {
    const extensions = ['c', 'cpp', 'cc', 'cxx', 'C', 'my-lang', 'd.ts', 'c++'];
    let list: SubmissionQueueEntry[] = [];
    for (const extension of extensions) {
      const incoming = entry(extension);
      incoming.input.extension = extension;
      list = putQueueEntry(list, incoming);
    }
    expect(list).toHaveLength(extensions.length);
    expect(list.map(item => submissionPath(item.input).split('/').at(-1)))
      .toEqual(extensions.map(extension => `cf4a_alice.${extension}`));
    expect(list.map(item => item.input.language)).toEqual(['c', 'cpp', 'cpp', 'cpp', 'cpp', 'other', 'other', 'cpp']);
  });

  it('uses the actual normalized suffix for conflicts regardless of the preset language', () => {
    const old = entry();
    old.input.extension = 'c';
    const incoming = entry('next');
    incoming.input = { ...incoming.input, language: 'py', extension: '.c' };
    expect(findQueueConflict([old], incoming)).toBe(old);
    expect(() => putQueueEntry([old], incoming)).toThrow('confirmation');
    const result = putQueueEntry([old], incoming, old.key);
    expect(result).toHaveLength(1);
    expect(result[0].input).toMatchObject({ language: 'c', extension: 'c' });
  });

  it('leaves the queue untouched when a manually supplied extension is invalid', () => {
    const old = entry();
    const incoming = entry('next');
    incoming.input.extension = '../cpp';
    expect(() => putQueueEntry([old], incoming)).toThrow();
    expect(old.input.code).toBe('int main() {}\n');
    expect(old.key).toBe('first');
  });

  it('replaces only the explicitly confirmed path and preserves list order', () => {
    const first = entry();
    const other = entry('other', 'bob');
    const incoming = entry('new');
    incoming.input.code = 'int main() { return 1; }';
    const result = putQueueEntry([other, first], incoming, first.key);
    expect(result.map(item => item.key)).toEqual(['other', 'new']);
    expect(result[0]).toBe(other);
    expect(result[1].input.code).toBe('int main() { return 1; }\n');
  });

  it('requires renewed consent when the conflicting entry changed or disappeared', () => {
    const old = entry();
    const incoming = entry('new');
    expect(() => putQueueEntry([{ ...old, key: 'changed' }], incoming, old.key)).toThrow('confirmation');
    expect(() => putQueueEntry([], incoming, old.key)).toThrow('no longer matches');
  });

  it('updates an existing item in place without treating its own path as a collision', () => {
    const before = entry();
    const other = entry('other', 'bob');
    const update = { ...before, input: { ...before.input, code: 'new code' } };
    expect(findQueueConflict([other, before], update)).toBeUndefined();
    const next = putQueueEntry([other, before], update);
    expect(next.map(item => item.key)).toEqual(['other', 'first']);
    expect(next[1].input.code).toBe('new code\n');
  });

  it('editing an author into another path requires consent and leaves only one file at that path', () => {
    const first = entry();
    const second = entry('second', 'bob');
    const edited = { ...second, input: { ...second.input, author: 'alice' } };
    expect(() => putQueueEntry([first, second], edited)).toThrow('confirmation');
    const next = putQueueEntry([first, second], edited, first.key);
    expect(next).toHaveLength(1);
    expect(next[0].key).toBe('second');
    expect(next[0].input.author).toBe('alice');
  });

  it('validates imported code before it can enter the list', () => {
    const invalid = entry();
    invalid.input.code = '  \n';
    expect(() => normalizeQueueEntry(invalid)).toThrow();
    expect(() => putQueueEntry([], invalid)).toThrow();
  });
});

describe('unconfirmed editor protection', () => {
  it('does not block closing a fresh editor or an unchanged existing file', () => {
    expect(queueEditorDirty(null, null)).toBe(false);
    expect(queueEditorDirty(createQueueEntry(day, day.problems[0], 'cpp', [], 'fresh'), null)).toBe(false);
    const original = entry();
    expect(queueEditorDirty({ ...original, input: { ...original.input } }, original)).toBe(false);
  });

  it.each(['author', 'language', 'extension', 'code', 'notes', 'date', 'problemId'] as const)('protects changes to %s in an existing file', field => {
    const original = entry();
    const changed = { ...original, input: { ...original.input, [field]: field === 'language' ? 'py' : 'changed' } } as SubmissionQueueEntry;
    expect(queueEditorDirty(changed, original)).toBe(true);
  });

  it('protects an imported empty file and a changed local filename', () => {
    const fresh = createQueueEntry(day, day.problems[0], 'cpp', [], 'fresh');
    expect(queueEditorDirty({ ...fresh, fileName: 'empty.cpp' }, null)).toBe(true);
    const original = entry();
    expect(queueEditorDirty({ ...original, fileName: 'replacement.cpp' }, original)).toBe(true);
  });

  it('does not confuse refreshed problem metadata with an edit to the uploaded file', () => {
    const original = entry();
    expect(queueEditorDirty({ ...original, problem: { ...original.problem, label: 'Updated remote title' }, unavailable: true }, original)).toBe(false);
  });
});
