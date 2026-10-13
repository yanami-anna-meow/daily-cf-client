import { afterEach, describe, expect, it } from 'vitest';
import { extensionLanguageLabel, importExtension, languageForExtension, normalizeExtension } from '../shared/file-formats';
import { setLocale } from '../shared/i18n';
import { referenceInfo } from '../shared/library-files';

afterEach(() => setLocale('zh-CN'));

describe('code file extensions', () => {
  it.each(['c', 'C', 'c++', 'CPP', 'd.ts', 'my.language', 'foo-bar', 'my_extension', '自定义', 'x`code`', 'my code'])('preserves a safe unrestricted suffix %s', extension => {
    expect(normalizeExtension(extension)).toBe(extension);
    expect(normalizeExtension(`.${extension}`)).toBe(extension);
  });

  it.each([undefined, null, 1, {}, '', '.', '..c', '../c', 'x/y', 'x\\y', 'x:y', 'x?y', 'x*y', 'x|y', 'x<y', 'x>y', 'x"y',
    '%2ec', 'c.', 'c ', 'c\t', 'c\n', 'c\0', 'c\u0085', 'c\u2028js', 'c\u2029js', '\uD800', '\uDC00'])('rejects unsafe or empty suffix %j', value => {
    expect(() => normalizeExtension(value)).toThrow();
  });

  it.each([
    ['solution.c', 'c'], ['solution.C', 'C'], ['solution.c++', 'c++'], ['solution.cc', 'cc'],
    ['solution.D.TS', 'D.TS'], ['solution.d.mts', 'd.mts'], ['solution.my.ext', 'ext'],
    ['solution.custom', 'custom'], ['C:\\uploads\\solution.c', 'c'], ['/uploads/solution.py3', 'py3'],
    ['solution', ''], ['.hidden', ''], ['solution.', ''],
  ])('imports the actual suffix from %s', (name, extension) => {
    expect(importExtension(name)).toBe(extension);
  });

  it.each([
    ['c', 'c', 'C'], ['C', 'cpp', 'C++'], ['cxx', 'cpp', 'C++'], ['c++', 'cpp', 'C++'],
    ['CPP', 'cpp', 'C++'], ['py3', 'py', 'Python'], ['jsx', 'js', 'JavaScript'],
    ['d.ts', 'other', 'TypeScript'], ['rb', 'other', 'Ruby'], ['constructor', 'other', '.constructor'],
    ['my.custom', 'other', '.my.custom'], ['Custom', 'other', '.Custom'],
    ['foo.cpp', 'cpp', 'C++'], ['foo.C', 'cpp', 'C++'], ['foo.c', 'c', 'C'], ['foo.py3', 'py', 'Python'],
  ])('recognizes %s without restricting unknown formats', (extension, language, label) => {
    expect(languageForExtension(extension)).toBe(language);
    expect(extensionLanguageLabel(extension)).toBe(label);
  });

  it('translates only the text label at rendering time', () => {
    expect(extensionLanguageLabel('txt')).toBe('文本');
    setLocale('en');
    expect(extensionLanguageLabel('txt')).toBe('Text');
    expect(extensionLanguageLabel('C')).toBe('C++');
    expect(extensionLanguageLabel('自定义')).toBe('.自定义');
  });

  it.each([
    ['c', 'C'], ['C', 'C++'], ['c++', 'C++'], ['d.ts', 'TypeScript'], ['Custom', '.Custom'], ['constructor', '.constructor'],
  ])('keeps custom reference filenames intact and derives their displayed format: %s', (extension, language) => {
    const name = `cf123a_author.${extension}`;
    expect(referenceInfo(`daily_problems/2128/02/0229/personal_submission/${name}`)).toEqual({ date: '2128-02-29', name, language });
  });
});
