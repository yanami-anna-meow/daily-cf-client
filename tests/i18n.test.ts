import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/locales/app', () => ({ en: {
  '测试翻译': 'Translated message',
  '你好，{{name}}。共 {{count}} 项。': 'Hello, {{name}}. {{count}} items.',
  '{{first}} / {{second}}': '{{second}} / {{first}}',
  '空白译文': '',
} }));

import { formatDate, formatNumber, getLocale, normalizeUiLanguage, resolveLocale, setLocale, subscribeLocale, t } from '../shared/i18n';

afterEach(() => { setLocale('zh-CN'); });

describe('interface language resolution', () => {
  it.each(['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans-CN', 'zh-Hant-TW', 'ZH_cn', ' zh-CN '])
    ('uses Chinese for primary system language %s', language => {
      expect(resolveLocale('system', [language])).toBe('zh-CN');
    });

  it.each(['en', 'en-US', 'en-GB', 'EN_au', 'fr-FR', 'ja-JP', 'de-DE', '', 'zhinvalid', 'zh-', 'zh--CN', 'zh<script>'])
    ('uses English for primary system language %s', language => {
      expect(resolveLocale('system', [language])).toBe('en');
    });

  it('uses the primary language rather than searching lower priority preferences', () => {
    expect(resolveLocale('system', ['fr-FR', 'zh-CN'])).toBe('en');
    expect(resolveLocale('system', ['en-US', 'zh-TW'])).toBe('en');
    expect(resolveLocale('system', ['zh-TW', 'en-US'])).toBe('zh-CN');
    expect(resolveLocale('system', [])).toBe('en');
  });

  it('honors an explicit preference independently of the system', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('zh-CN', ['ja-JP'])).toBe('zh-CN');
  });

  it.each([undefined, null, 0, false, {}, [], 'zh', 'en-US', 'SYSTEM', '__proto__'])
    ('normalizes an invalid stored preference %j to system', value => {
      expect(normalizeUiLanguage(value)).toBe('system');
      expect(resolveLocale(value as 'system', ['zh-TW'])).toBe('zh-CN');
      expect(resolveLocale(value as 'system', ['ja-JP'])).toBe('en');
    });

  it('retains every supported persisted value', () => {
    expect(normalizeUiLanguage('system')).toBe('system');
    expect(normalizeUiLanguage('en')).toBe('en');
    expect(normalizeUiLanguage('zh-CN')).toBe('zh-CN');
  });

  it('notifies on effective locale changes, and unsubscribe stops delivery', () => {
    setLocale('zh-CN');
    const seen: string[] = [];
    const unsubscribe = subscribeLocale(() => { seen.push(getLocale()); });
    setLocale('system', ['zh-HK']);
    setLocale('en');
    setLocale('system', ['fr-FR']);
    setLocale('zh-CN');
    unsubscribe();
    unsubscribe();
    setLocale('en');
    expect(seen).toEqual(['en', 'zh-CN']);
  });
});

describe('exact message lookup and safe interpolation', () => {
  it('uses the source Chinese verbatim and a precise English catalog match', () => {
    setLocale('zh-CN');
    expect(t('测试翻译')).toBe('测试翻译');
    setLocale('en');
    expect(t('测试翻译')).toBe('Translated message');
    expect(t('prefix 测试翻译 suffix')).toBe('prefix 测试翻译 suffix');
    expect(t('未收录的消息')).toBe('未收录的消息');
    expect(t('空白译文')).toBe('');
    expect(t('__proto__')).toBe('__proto__');
    expect(t('toString')).toBe('toString');
  });

  it('interpolates both languages and preserves zero', () => {
    expect(t('你好，{{name}}。共 {{count}} 项。', { name: 'Alice', count: 0 })).toBe('你好，Alice。共 0 项。');
    setLocale('en');
    expect(t('你好，{{name}}。共 {{count}} 项。', { name: 'Alice', count: 2 })).toBe('Hello, Alice. 2 items.');
    expect(t('{{first}} / {{second}}', { first: 'A', second: 'B' })).toBe('B / A');
  });

  it('never translates or recursively interpolates supplied user content', () => {
    setLocale('en');
    expect(t('你好，{{name}}。共 {{count}} 项。', { name: '测试翻译 {{count}} <script>', count: 3 }))
      .toBe('Hello, 测试翻译 {{count}} <script>. 3 items.');
    expect(t('{{name}}', { name: '$& $1 $$ {{name}}' })).toBe('$& $1 $$ {{name}}');
  });

  it('leaves absent placeholders intact and ignores inherited interpolation properties', () => {
    expect(t('{{ missing }} {{constructor}} {{present}}', Object.assign(Object.create({ missing: 'unsafe' }), { present: 1 })))
      .toBe('{{ missing }} {{constructor}} 1');
    expect(t('{{present}} {{ absent }}', { present: '' })).toBe(' {{ absent }}');
  });
});

describe('locale-aware numbers and repository dates', () => {
  it('uses the selected locale for numbers and date labels', () => {
    setLocale('en');
    expect(formatNumber(12345)).toBe('12,345');
    expect(formatDate('2026-10-08', { month: 'long', day: 'numeric' })).toBe('October 8');
    setLocale('zh-CN');
    expect(formatDate('2026-10-08', { month: 'long', day: 'numeric' })).toBe('10月8日');
  });

  it('keeps calendar dates fixed regardless of time zone, including leap days and future years', () => {
    setLocale('en');
    const options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', timeZone: 'Pacific/Kiritimati' };
    expect(formatDate('2028-02-29', options)).toBe('February 29');
    expect(formatDate('9999-12-31', options)).toBe('December 31');
    expect(formatDate('0001-01-01', options)).toBe('January 1');
    expect(formatDate('2027-02-29', options)).toBe('2027-02-29');
  });

  it('honors time zones for actual timestamps and degrades invalid dates to their original text', () => {
    setLocale('en');
    expect(formatDate('2026-10-08T01:00:00.000Z', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' }))
      .toBe('October 7');
    expect(formatDate('unknown')).toBe('unknown');
    expect(formatDate(new Date('invalid'))).toBe('Invalid Date');
  });
});

describe('translation catalog contracts', () => {
  it('preserves interpolation parameters and rejects conflicting shared message translations', async () => {
    const catalogs = await Promise.all([
      vi.importActual<{ en: Record<string, string> }>('../shared/locales/app'),
      vi.importActual<{ en: Record<string, string> }>('../shared/locales/backend'),
      vi.importActual<{ en: Record<string, string> }>('../shared/locales/components'),
      vi.importActual<{ en: Record<string, string> }>('../shared/locales/composer'),
      vi.importActual<{ en: Record<string, string> }>('../shared/locales/native'),
      vi.importActual<{ en: Record<string, string> }>('../shared/locales/shared'),
    ]);
    const placeholders = (message: string) => [...new Set([...message.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map(match => match[1]))].sort();
    // This is a literal example of the user's template syntax, not an interpolated
    // app parameter. Its translated identifier deliberately remains visible.
    const literalExamples: Record<string, string[]> = {
      '{{field}}模板的变量格式不完整，请使用 {{变量名}}。': ['variable_name'],
    };
    const translations = new Map<string, string>();
    const problems: string[] = [];
    for (const { en } of catalogs) {
      for (const [source, translation] of Object.entries(en)) {
        const translatedParameters = placeholders(translation).filter(name => !literalExamples[source]?.includes(name));
        if (JSON.stringify(translatedParameters) !== JSON.stringify(placeholders(source))) problems.push(`Parameters for ${source}: ${JSON.stringify(translatedParameters)}`);
        if (translations.has(source) && translation !== translations.get(source)) problems.push(`Conflicting translation for ${source}: ${translation} / ${translations.get(source)}`);
        translations.set(source, translation);
      }
    }
    expect(problems).toEqual([]);
  });
});
