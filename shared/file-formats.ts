import { t } from './i18n';
import { LANGUAGES, type Language } from './types';

// Language recognition is a convenience, never a list of permitted submissions.
const FORMAT_LABELS: Readonly<Record<string, string>> = {
  cpp: 'C++', cc: 'C++', cxx: 'C++', 'c++': 'C++', c: 'C', h: 'C / C++', hpp: 'C++',
  py: 'Python', py3: 'Python', java: 'Java', rs: 'Rust', go: 'Go', cs: 'C#',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  'd.ts': 'TypeScript', 'd.mts': 'TypeScript', 'd.cts': 'TypeScript',
  kt: 'Kotlin', kts: 'Kotlin', rb: 'Ruby', swift: 'Swift', scala: 'Scala',
  php: 'PHP', pas: 'Pascal', d: 'D', hs: 'Haskell', ml: 'OCaml', fs: 'F#',
  fsharp: 'F#', pl: 'Perl', r: 'R', txt: 'Text',
};
const LANGUAGE_ALIASES: Readonly<Record<string, Language>> = {
  cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', h: 'cpp', py3: 'py',
  jsx: 'js', mjs: 'js', cjs: 'js', kts: 'kt',
};

/** Normalize just the optional leading dot; preserve the case and suffix chosen by the user. */
export function normalizeExtension(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error(t('请输入文件扩展名。'));
  const extension = value.startsWith('.') ? value.slice(1) : value;
  if (!extension) throw new Error(t('请输入文件扩展名。'));
  // These suffixes become cross-platform filenames, and remain literal URL path segments.
  // Percent is rejected consistently with the reference-read path boundary.
  if (extension.startsWith('.') || /[<>:"/\\|?*%\p{Cc}\u2028\u2029]/u.test(extension) || /[.\s]$/.test(extension)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(extension)) {
    throw new Error(t('扩展名不能包含路径、控制字符或文件名禁用字符，也不能以点或空格结尾。'));
  }
  return extension;
}

function recognizedExtension(extension: string): string | undefined {
  // An arbitrary compound suffix still follows its final known language suffix.
  // The full suffix remains the file identity; this only chooses its display/highlighting.
  return [extension, extension.slice(extension.lastIndexOf('.') + 1)]
    .find(candidate => candidate === 'C' || Object.hasOwn(FORMAT_LABELS, candidate.toLowerCase()));
}

export function languageForExtension(extension: string): Language {
  const suffix = recognizedExtension(extension) ?? extension;
  // A capital .C conventionally denotes C++, unlike a lower-case .c file.
  if (suffix === 'C') return 'cpp';
  const lower = suffix.toLowerCase();
  return (Object.hasOwn(LANGUAGE_ALIASES, lower) ? LANGUAGE_ALIASES[lower] : undefined)
    ?? LANGUAGES.find(language => language.id !== 'other' && language.extension === lower)?.id
    ?? 'other';
}

export function extensionLanguageLabel(extension: string): string {
  const suffix = recognizedExtension(extension);
  if (suffix === 'C') return 'C++';
  if (!suffix) return `.${extension}`;
  const lower = suffix.toLowerCase();
  if (lower === 'txt') return t('文本');
  return Object.hasOwn(FORMAT_LABELS, lower) ? FORMAT_LABELS[lower] : `.${extension}`;
}

/** Keep known compound extensions; other names use the final suffix, without guessing a language. */
export function importExtension(filename: string): string {
  const name = filename.split(/[\\/]/).pop() ?? '';
  const compound = /\.(d\.(?:ts|mts|cts))$/i.exec(name);
  if (compound) return compound[1];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}
