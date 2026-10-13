import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSubmissionPreview, normalizeProblemId, parseProblems, repositoryDatePath, submissionExtension, submissionFileName, submissionPath, validateDate, validateSubmission } from '../shared/domain';
import { LANGUAGES, UPSTREAM, type SubmissionInput } from '../shared/types';

const input: SubmissionInput = { date: '2026-10-07', problemId: 'GYM106744G', language: 'cpp', author: 'alice', code: 'int main() {}', notes: '' };

describe('submission validation and repository paths', () => {
  it('generates the actual filename from identity alone before code or date is provided', () => {
    expect(submissionFileName({ problemId: ' GYM106744G ', language: 'cpp', author: ' anna ' }))
      .toBe('cf106744g_anna.cpp');
    for (const language of LANGUAGES) {
      const identity = { problemId: 'cf106744g', language: language.id, author: 'Anna' };
      const filename = submissionFileName(identity);
      expect(filename).toBe(`cf106744g_Anna.${language.extension}`);
      expect(submissionPath({ ...input, ...identity, date: '2128-02-29' }))
        .toBe(`daily_problems/2128/02/0229/personal_submission/${filename}`);
    }
  });

  it('does not invent a filename for an empty or invalid signature', () => {
    for (const author of ['', '   ', '../anna', '_anna', 'a'.repeat(40)]) {
      expect(() => submissionFileName({ problemId: 'cf106744g', language: 'cpp', author })).toThrow('署名');
    }
    expect(() => submissionFileName({ problemId: '../cf106744g', language: 'cpp', author: 'anna' })).toThrow();
  });

  it('uses the actual calendar, including leap years', () => {
    expect(validateDate('2024-02-29')).toBe('2024-02-29');
    for (const invalid of ['2026-02-29', '2100-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '0000-01-01', '10000-01-01', '../2026-01-01', '2026-01-01T00:00:00Z']) {
      expect(() => validateDate(invalid), invalid).toThrow();
    }
    expect(repositoryDatePath('2024-02-29')).toBe('daily_problems/2024/02/0229');
  });

  it('accepts every valid four-digit Gregorian year without a launch-year or current-year cutoff', () => {
    for (const date of ['0001-01-01', '0099-12-31', '0100-01-01', '1999-12-31', '2019-12-31', '2101-01-01', '2400-02-29', '9999-12-31']) {
      expect(validateDate(date)).toBe(date);
      const [year, month, day] = date.split('-');
      expect(repositoryDatePath(date)).toBe(`daily_problems/${year}/${month}/${month}${day}`);
    }
    for (const date of ['0001-02-29', '0099-02-29', '0100-02-29', '1900-02-29']) expect(() => validateDate(date)).toThrow();
  });

  it('normalizes Codeforces and GYM identifiers into repository filenames', () => {
    expect(normalizeProblemId(' CF1878F ')).toBe('cf1878f');
    expect(normalizeProblemId('GYM106744G')).toBe('cf106744g');
    expect(normalizeProblemId('1999F1')).toBe('cf1999f1');
    expect(submissionPath(input)).toBe('daily_problems/2026/10/1007/personal_submission/cf106744g_alice.cpp');
    for (const language of LANGUAGES) {
      expect(submissionPath({ ...input, language: language.id }).endsWith(`.${language.extension}`)).toBe(true);
    }
    for (const invalid of ['../cf1a', 'cf1a/../../evil', 'cf0a', 'abc', 'cf123', 'cf123a.exe', 'cf123_A', 'https://codeforces.com/problemset/problem/1/A']) {
      expect(() => normalizeProblemId(invalid), invalid).toThrow();
    }
  });

  it('normalizes text without changing code indentation', () => {
    expect(validateSubmission({ ...input, author: ' alice ', code: '\uFEFF  // 注释\r\nint main() {}\r', notes: '  思路  ' })).toEqual({
      ...input, extension: 'cpp', problemId: 'cf106744g', code: '  // 注释\nint main() {}\n', notes: '思路'
    });
    expect(validateSubmission(input).code).toBe('int main() {}\n');
  });

  it('rejects traversal, unsupported languages, empty code, and non-text content', () => {
    for (const author of ['../alice', 'alice/a', 'alice\\a', '-alice', '爱丽丝', 'a'.repeat(40), 'alice.txt', '']) {
      expect(() => validateSubmission({ ...input, author }), author).toThrow();
    }
    expect(() => validateSubmission({ ...input, language: 'exe' as SubmissionInput['language'] })).toThrow();
    for (const code of ['', '\r\n \t', '\uFEFF', 'int\0 main()']) expect(() => validateSubmission({ ...input, code })).toThrow();
    expect(() => validateSubmission({ ...input, notes: 'a'.repeat(2001) })).toThrow();
    expect(() => validateSubmission(null as unknown as SubmissionInput)).toThrow();
  });

  it('measures the UTF-8 byte limit after normalizing line endings', () => {
    expect(validateSubmission({ ...input, code: 'x'.repeat(256 * 1024 - 1) }).code.length).toBe(256 * 1024);
    expect(() => validateSubmission({ ...input, code: 'x'.repeat(256 * 1024) })).toThrow('256 KiB');
    expect(() => validateSubmission({ ...input, code: '羊'.repeat(90_000) })).toThrow('256 KiB');
    expect(validateSubmission({ ...input, code: 'x\r\n'.repeat(100_000) }).code.length).toBe(200_000);
  });

  it.each([
    ['.c', 'c', 'c'], ['C', 'C', 'cpp'], ['c++', 'c++', 'cpp'], ['cxx', 'cxx', 'cpp'],
    ['py3', 'py3', 'py'], ['d.ts', 'd.ts', 'other'], ['MyLanguage', 'MyLanguage', 'other'],
    ['自定义', '自定义', 'other'], ['constructor', 'constructor', 'other'],
    ['foo.cpp', 'foo.cpp', 'cpp'], ['foo.C', 'foo.C', 'cpp'], ['foo.c', 'foo.c', 'c'],
  ])('uses the actual extension %s as file identity and derives the language', (value, extension, language) => {
    const normalized = validateSubmission({ ...input, language: 'java', extension: value });
    expect(normalized).toMatchObject({ extension, language });
    expect(submissionExtension(normalized)).toBe(extension);
    expect(submissionFileName(normalized)).toBe(`cf106744g_alice.${extension}`);
    expect(submissionPath(normalized)).toBe(`daily_problems/2026/10/1007/personal_submission/cf106744g_alice.${extension}`);
    expect(validateSubmission(normalized)).toEqual(normalized);
  });

  it('distinguishes missing legacy suffix from an explicit empty suffix', () => {
    expect(validateSubmission({ ...input, language: 'c' })).toMatchObject({ language: 'c', extension: 'c' });
    expect(validateSubmission({ ...input, language: 'other' })).toMatchObject({ language: 'other', extension: 'txt' });
    expect(() => validateSubmission({ ...input, extension: '' })).toThrow('扩展名');
    expect(submissionPath({ ...input, extension: 'c' })).not.toBe(submissionPath({ ...input, extension: 'C' }));
    expect(submissionPath({ ...input, extension: 'c', language: 'py' })).toBe(submissionPath({ ...input, extension: 'c', language: 'cpp' }));
  });

  it('bounds the complete filename in UTF-8 bytes rather than arbitrary extension length', () => {
    const prefix = 'cf106744g_alice.';
    const extension = 'x'.repeat(255 - Buffer.byteLength(prefix));
    expect(Buffer.byteLength(submissionFileName({ ...input, extension }))).toBe(255);
    expect(() => submissionFileName({ ...input, extension: extension + 'x' })).toThrow('255 字节');
    const unicode = '羊'.repeat(Math.floor((255 - Buffer.byteLength(prefix)) / 3));
    expect(Buffer.byteLength(submissionFileName({ ...input, extension: unicode }))).toBeLessThanOrEqual(255);
    expect(() => submissionFileName({ ...input, extension: unicode + '羊' })).toThrow('255 字节');
  });
});

describe('repository problem tables', () => {
  it.each([0, 1, 3, 4, 7])('preserves all %i daily problems in source order with independent metadata', count => {
    const cases = [
      { id: 'cf773a', label: 'CF773A', url: 'https://codeforces.com/problemset/problem/773/A', rating: 1700, ratingSource: 'official', kind: 'round' },
      { id: 'cf106744g', label: 'GYM106744G', url: 'https://codeforces.com/gym/106744/problem/G', rating: 1000, ratingSource: 'estimated', kind: 'gym' },
      { id: 'cf1185c2', label: 'CF1185C2', url: 'https://codeforces.com/contest/1185/problem/C2', rating: 1900, ratingSource: 'estimated', kind: 'round' },
      { id: 'cf103627a', label: 'GYM103627A', url: 'https://codeforces.com/gym/103627/problem/A', rating: 2100, ratingSource: 'official', kind: 'gym' },
      { id: 'cf1a', label: 'CF1A', url: 'https://codeforces.com/problemset/problem/1/A', rating: null, ratingSource: 'unknown', kind: 'round' },
      { id: 'cf106174c', label: 'GYM106174C', url: 'https://codeforces.com/gym/106174/problem/3', rating: 1600, ratingSource: 'estimated', kind: 'gym' },
      { id: 'cf1999f1', label: 'CF1999F1', url: 'https://codeforces.com/problemset/problem/1999/F1', rating: 800, ratingSource: 'official', kind: 'round' },
    ].slice(0, count);
    const markdown = ['| Difficulty | Problems | Hints |', '| --- | --- | --- |', ...cases.map((problem, index) => {
      const difficulty = problem.rating === null ? '?' : `${problem.ratingSource === 'estimated' ? '*' : ''}${problem.rating}`;
      return `| ${difficulty} | [${problem.label}](${problem.url}) | Hint ${index + 1}: preserve $|x-y|$. |`;
    })].join('\n');
    expect(parseProblems(markdown, input.date)).toEqual(cases.map((problem, index) => ({
      ...problem, hint: `Hint ${index + 1}: preserve $|x-y|$.`,
    })));
  });

  it('parses actual GYM daily table format', () => {
    const markdown = '| Difficulty | Problems | Hints |\n| -------- | -------- | -------- |\n| *1000 | [GYM106744G](https://codeforces.com/gym/106744/problem/G) | Greedy. |\n| *2100 | [GYM103627A](https://codeforces.com/gym/103627/problem/A) | Simplify $\\max(u_x+v_x,u_y+v_y)$ . |';
    expect(parseProblems(markdown, input.date)).toEqual([
      { id: 'cf106744g', label: 'GYM106744G', url: 'https://codeforces.com/gym/106744/problem/G', kind: 'gym', rating: 1000, ratingSource: 'estimated', hint: 'Greedy.' },
      { id: 'cf103627a', label: 'GYM103627A', url: 'https://codeforces.com/gym/103627/problem/A', kind: 'gym', rating: 2100, ratingSource: 'estimated', hint: 'Simplify $\\max(u_x+v_x,u_y+v_y)$ .' }
    ]);
  });

  it('preserves hints containing table-like LaTeX and resolves daily editorials', () => {
    const markdown = '| 1700 | [CF773A](https://codeforces.com/problemset/problem/773/A) | Count $|x-y|$ and $\\{x | x > 0\\}$; use A \\| B. | [Editorial](./solution/cf773a.md) |';
    expect(parseProblems(markdown, '2024-03-19')[0]).toEqual({
      id: 'cf773a', label: 'CF773A', url: 'https://codeforces.com/problemset/problem/773/A', kind: 'round', rating: 1700, ratingSource: 'official',
      hint: 'Count $|x-y|$ and $\\{x | x > 0\\}$; use A \\| B.',
      editorialUrl: `${UPSTREAM.url}/blob/main/daily_problems/2024/03/0319/solution/cf773a.md`
    });
  });

  it('resolves README repository-relative and absolute editorial links', () => {
    for (const target of ['daily_problems/2026/10/1007/solution/cf106744g.md', './daily_problems/2026/10/1007/solution/cf106744g.md', 'https://github.com/Yawn-Sean/Daily_CF_Problems/blob/main/daily_problems/2026/10/1007/solution/cf106744g.md']) {
      const markdown = `| *1000 | [GYM106744G](https://codeforces.com/gym/106744/problem/G) | Greedy. | [Editorial](${target}) |`;
      const expected = target.startsWith('https://') ? target : `${UPSTREAM.url}/blob/main/daily_problems/2026/10/1007/solution/cf106744g.md`;
      expect(parseProblems(markdown, input.date)[0].editorialUrl).toBe(expected);
    }
  });

  it('accepts contest routes and unknown difficulty while deduplicating problems', () => {
    const markdown = '| ? | [CF123A1](http://www.codeforces.com/contest/123/problem/A1?locale=en#test) | Hint | |\n| 800 | [CF123A1](https://codeforces.com/problemset/problem/123/A1) | Another hint |';
    expect(parseProblems(markdown, input.date)).toEqual([{ id: 'cf123a1', label: 'CF123A1', url: 'http://www.codeforces.com/contest/123/problem/A1?locale=en#test', kind: 'round', rating: null, ratingSource: 'unknown', hint: 'Hint' }]);
  });

  it.each([
    ['CF123A1', 'https://www.codeforces.com/contest/123/problem/A1?locale=en#statement', 'cf123a1', 'round'],
    ['CF123A1', 'https://codeforces.com/problemset/problem/123/A1?locale=ru&x=%2f#note', 'cf123a1', 'round'],
    ['GYM104535E', 'http://www.codeforces.com/gym/104535/problem/911.E?locale=en#sample', 'cf104535e', 'gym'],
    ['GYM104852D', 'https://Codeforces.com/gym/104852/problem/4?locale=en#note', 'cf104852d', 'gym'],
  ])('keeps the original link independent of the internal identity: %s', (label, url, id, kind) => {
    expect(parseProblems(`| *1600 | [${label}](${url}) | Hint |`, input.date)[0])
      .toMatchObject({ id, url, kind });
  });

  it.each([
    ['*1000', 'https://codeforces.com/gym/106744/problem/G', 'CF106744G', 'estimated', 'gym'],
    ['1000', 'https://codeforces.com/gym/106744/problem/G', 'CF106744G', 'official', 'gym'],
    ['*1000', 'https://codeforces.com/contest/1185/problem/C2', 'GYM1185C2', 'estimated', 'round'],
    ['1000', 'https://codeforces.com/problemset/problem/1185/C2', 'GYM1185C2', 'official', 'round'],
  ] as const)('keeps rating source %s and URL kind independent for %s', (difficulty, url, label, ratingSource, kind) => {
    const parsed = parseProblems(`| ${difficulty} | [${label}](${url}) | Hint |`, input.date);
    expect(parsed[0]).toMatchObject({ rating: 1000, ratingSource, kind, label });
    expect(parsed[0].id).toBe(kind === 'gym' ? 'cf106744g' : 'cf1185c2');
  });

  it.each([
    ['https://codeforces.com/gym/106744/problem/G', 'gym'],
    ['https://codeforces.com/contest/1185/problem/C2', 'round'],
    ['https://codeforces.com/problemset/problem/1185/C2', 'round'],
  ] as const)('keeps missing rating unknown independently of URL kind: %s', (url, kind) => {
    expect(parseProblems(`| ? | [Problem](${url}) | Hint |`, input.date)[0])
      .toMatchObject({ rating: null, ratingSource: 'unknown', kind });
  });

  it.each([
    ['GYM104852D', 'https://codeforces.com/gym/104852/problem/4', 'cf104852d'],
    ['GYM104535E', 'https://codeforces.com/gym/104535/problem/911.E', 'cf104535e'],
    ['GYM106174C', 'https://codeforces.com/gym/106174/problem/3', 'cf106174c'],
    ['GYM106247B', 'https://codeforces.com/gym/106247/problem/2', 'cf106247b'],
    ['GYM106247D', 'https://codeforces.com/gym/106247/problem/4', 'cf106247d'],
  ])('recognizes actual custom Gym URL indexes using the same-contest repository label: %s', (label, url, id) => {
    expect(parseProblems(`| *1600 | [${label}](${url}) | Hint |`, input.date)[0])
      .toMatchObject({ id, label, url, kind: 'gym', ratingSource: 'estimated' });
  });

  it('warns about upstream label typos while keeping the normal URL ID authoritative', () => {
    const problem = parseProblems('| *1700 | [GYM106631F](https://codeforces.com/gym/106631/problem/A) | Find the start. |', '2026-07-31')[0];
    expect(problem).toMatchObject({ id: 'cf106631a', label: 'GYM106631F', kind: 'gym' });
    expect(problem.sourceWarning).toContain('GYM106631F');
    expect(problem.sourceWarning).toContain('CF106631A');
  });

  it('rejects custom Gym indexes without a valid same-contest label and non-Gym numeric routes', () => {
    for (const [label, url] of [
      ['GYM999D', 'https://codeforces.com/gym/104852/problem/4'],
      ['Unknown', 'https://codeforces.com/gym/104852/problem/4'],
      ['CF104852D', 'https://codeforces.com/contest/104852/problem/4'],
      ['GYM104852D', 'https://codeforces.com/gym/104852/problem/../4'],
    ]) expect(parseProblems(`| *1600 | [${label}](${url}) | Hint |`, input.date)).toEqual([]);
  });

  it('keeps official editorial links when the upstream points at a test fork', () => {
    const original = { ...UPSTREAM };
    Object.assign(UPSTREAM, { owner: 'alice', repo: 'daily-cf-test', url: 'https://github.com/alice/daily-cf-test' });
    try {
      for (const target of ['https://github.com/Yawn-Sean/Daily_CF_Problems/blob/main/daily_problems/2026/10/1007/solution/cf1a.md', 'https://github.com/alice/daily-cf-test/blob/main/daily_problems/2026/10/1007/solution/cf1a.md']) {
        const parsed = parseProblems(`| 800 | [CF1A](https://codeforces.com/problemset/problem/1/A) | Hint | [Editorial](${target}) |`, input.date);
        expect(parsed[0].editorialUrl).toBe(target);
      }
      const relative = parseProblems('| 800 | [CF1A](https://codeforces.com/problemset/problem/1/A) | Hint | [Editorial](solution/cf1a.md) |', input.date);
      expect(relative[0].editorialUrl).toBe('https://github.com/alice/daily-cf-test/blob/main/daily_problems/2026/10/1007/solution/cf1a.md');
    } finally {
      Object.assign(UPSTREAM, original);
    }
  });

  it('ignores malformed and spoofed problem links and rejects unsafe editorials', () => {
    for (const target of ['https://evil.test/problemset/problem/1/A', 'https://codeforces.com.evil.test/problemset/problem/1/A', 'https://codeforces.com@evil.test/problemset/problem/1/A', 'javascript:alert(1)', 'https://codeforces.com/profile/1', 'https://codeforces.com:1234/problemset/problem/1/A']) {
      expect(parseProblems(`| 800 | [CF1A](${target}) | Hint |`, input.date)).toEqual([]);
    }
    for (const target of ['https://evil.test/a.md', 'javascript:alert(1)', 'https://github.com/other/repo/blob/main/solution/cf1a.md', '../../../../../../evil.md']) {
      const parsed = parseProblems(`| 800 | [CF1A](https://codeforces.com/problemset/problem/1/A) | Hint | [Editorial](${target}) |`, input.date);
      expect(parsed[0].editorialUrl).toBeUndefined();
      expect(parsed[0].hint).toBe('Hint');
    }
    expect(parseProblems('# Empty day', input.date)).toEqual([]);
  });
});

describe('submission preview identity', () => {
  it('matches native SHA-256 and uses the repository title convention', () => {
    const normalized = validateSubmission({ ...input, code: '// 羊\nint main() {}' });
    const expectedHash = createHash('sha256').update(JSON.stringify({ ...normalized, login: 'alice' })).digest('hex').slice(0, 16);
    const preview = buildSubmissionPreview(normalized, 'Alice');
    expect(preview.branch).toBe(`daily-cf/2026-10-07/cf106744g-cpp-${expectedHash}`);
    expect(preview.title).toBe('20261007 cf106744g (C++) - alice');
    expect(preview.bytes).toBe(Buffer.byteLength(normalized.code, 'utf8'));
    expect(preview.existing).toBe(false);
  });

  it('reuses identity for normalized code and changes it for meaningful edits or users', () => {
    const original = buildSubmissionPreview(input, 'alice');
    expect(buildSubmissionPreview({ ...input, problemId: 'cf106744g', code: '\uFEFFint main() {}\r\n', notes: ' ' }, 'ALICE')).toEqual(original);
    for (const changed of [{ ...input, code: 'int main() {return 1;}' }, { ...input, notes: 'Different approach' }, { ...input, author: 'bob' }, { ...input, date: '2026-10-08' }]) {
      expect(buildSubmissionPreview(changed, 'alice').branch).not.toBe(original.branch);
    }
    expect(buildSubmissionPreview(input, 'bob').branch).not.toBe(original.branch);
  });

  it('hashes UTF-8 and multi-block inputs correctly', () => {
    for (const code of ['x', 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(128), '中文🙂'.repeat(100), 'a'.repeat(100_000)]) {
      const normalized = validateSubmission({ ...input, code });
      const expectedHash = createHash('sha256').update(JSON.stringify({ ...normalized, login: 'preview' })).digest('hex').slice(0, 16);
      expect(buildSubmissionPreview(normalized).branch.endsWith(expectedHash)).toBe(true);
    }
  });
});
