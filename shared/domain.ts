import { t } from './i18n';
import { LANGUAGES, UPSTREAM, type Problem, type SubmissionInput, type SubmissionPreview } from './types';
import { extensionLanguageLabel, languageForExtension, normalizeExtension } from './file-formats';

/** Identifies the parser output schema used by repository readers and corpus audits. */
export const PARSER_VERSION = 2;

const MAX_CODE_BYTES = 256 * 1024;
const encoder = new TextEncoder();

export function validateDate(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(t('日期必须使用 YYYY-MM-DD 格式。'));
  }
  const [year, month, day] = value.split('-').map(Number);
  // Date.UTC treats years 0–99 as 1900–1999. setUTCFullYear preserves the
  // actual four-digit repository year without imposing a client launch date.
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (year < 1 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(t('请选择 0001 至 9999 年之间的有效公历日期。'));
  }
  return value;
}

export function normalizeProblemId(value: string): string {
  if (typeof value !== 'string') throw new Error(t('请输入有效题号，例如 CF1234A。'));
  const match = /^(?:cf|gym)?([1-9]\d{0,8})([a-z]\d{0,2})$/i.exec(value.trim());
  if (!match) throw new Error(t('请输入有效题号，例如 CF1234A 或 GYM106744G。'));
  return `cf${match[1]}${match[2].toLowerCase()}`;
}

type SubmissionFileIdentity = Pick<SubmissionInput, 'problemId' | 'language' | 'extension' | 'author'>;

export function submissionExtension(input: Pick<SubmissionInput, 'language' | 'extension'>): string {
  if (input.extension !== undefined) return normalizeExtension(input.extension);
  const language = LANGUAGES.find(language => language.id === input.language);
  if (!language) throw new Error(t('请选择支持的编程语言。'));
  return language.extension;
}

function validateFileIdentity(input: SubmissionFileIdentity): SubmissionFileIdentity {
  if (!input || typeof input !== 'object') throw new Error(t('提交内容无效。'));
  const problemId = normalizeProblemId(input.problemId);
  const extension = submissionExtension(input);
  const author = typeof input.author === 'string' ? input.author.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(author)) {
    throw new Error(t('署名须为 1–39 个英文字母、数字、下划线或连字符，并以字母或数字开头。'));
  }
  if (encoder.encode(`${problemId}_${author}.${extension}`).byteLength > 255) {
    throw new Error(t('提交文件名不能超过 255 字节，请缩短署名或扩展名。'));
  }
  return { problemId, language: languageForExtension(extension), extension, author };
}

/** A filename is determined before a date or code file is selected. */
export function submissionFileName(input: SubmissionFileIdentity): string {
  const normalized = validateFileIdentity(input);
  return `${normalized.problemId}_${normalized.author}.${normalized.extension}`;
}

export function validateSubmission(input: SubmissionInput): SubmissionInput {
  if (!input || typeof input !== 'object') throw new Error(t('提交内容无效。'));
  const date = validateDate(input.date);
  const { problemId, language, extension, author } = validateFileIdentity(input);
  if (typeof input.code !== 'string') throw new Error(t('请输入或导入代码。'));
  let code = input.code.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!code.trim()) throw new Error(t('代码内容不能为空。'));
  if (code.includes('\0')) throw new Error(t('代码包含空字节，请导入 UTF-8 文本文件。'));
  if (!code.endsWith('\n')) code += '\n';
  if (encoder.encode(code).byteLength > MAX_CODE_BYTES) throw new Error(t('代码文件不能超过 256 KiB。'));
  if (typeof input.notes !== 'string') throw new Error(t('提交说明必须是文本。'));
  const notes = input.notes.trim();
  if (notes.length > 2000) throw new Error(t('提交说明不能超过 2000 个字符。'));
  return { date, problemId, language, extension, author, code, notes };
}

export function repositoryDatePath(date: string): string {
  const [year, month, day] = validateDate(date).split('-');
  return `daily_problems/${year}/${month}/${month}${day}`;
}

export function submissionPath(input: SubmissionInput): string {
  const normalized = validateSubmission(input);
  return `${repositoryDatePath(normalized.date)}/personal_submission/${submissionFileName(normalized)}`;
}

interface MarkdownLink { label: string; target: string; index: number; end: number; }

function markdownLinks(line: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const pattern = /\[([^\]\r\n]+)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of line.matchAll(pattern)) {
    links.push({ label: match[1], target: match[2], index: match.index!, end: match.index! + match[0].length });
  }
  return links;
}

function codeforcesProblem(target: string, label: string): { id: string; url: string; kind: NonNullable<Problem['kind']>; sourceWarning?: string } | null {
  try {
    if (/[\u0000-\u0020\u007f\\]/.test(target)) return null;
    const url = new URL(target);
    if (!['https:', 'http:'].includes(url.protocol) || !['codeforces.com', 'www.codeforces.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    const match = /^\/(?:problemset\/problem\/([1-9]\d{0,8})\/([a-z]\d{0,2})|(?:contest|gym)\/([1-9]\d{0,8})\/problem\/([a-z]\d{0,2}|\d+(?:\.[a-z]\d{0,2})?))\/?$/i.exec(url.pathname);
    if (!match) return null;
    const kind = /^\/gym\//i.test(url.pathname) ? 'gym' : 'round';
    const contestId = match[1] || match[3];
    const urlIndex = match[2] || match[4];
    const normalIndex = /^[a-z]\d{0,2}$/i.test(urlIndex);
    const labelId = /^(?:cf|gym)([1-9]\d{0,8})([a-z]\d{0,2})$/i.exec(label.trim());
    // Some Gym imports use numeric or dotted original indexes, e.g. /4 and
    // /911.E. The repository's same-contest label supplies their code filename.
    if (!normalIndex && (kind !== 'gym' || !labelId || labelId[1] !== contestId)) return null;
    const id = normalizeProblemId(`${contestId}${normalIndex ? urlIndex : labelId![2]}`);
    const sourceWarning = labelId && normalizeProblemId(`${labelId[1]}${labelId[2]}`) !== id
      ? t('原仓库题号标注 {{label}} 与题目链接不一致，客户端按链接识别为 {{id}}。提交前请核对原题与官方题解。', { label: label.trim(), id: id.toUpperCase() })
      : undefined;
    // Parse only to identify the problem. Navigation keeps the repository's link.
    return { id, url: target, kind, ...(sourceWarning ? { sourceWarning } : {}) };
  } catch { return null; }
}

function resolveEditorial(target: string, date: string): string | undefined {
  try {
    const root = `${UPSTREAM.url}/blob/main/`;
    // README links start at the repository root; daily problems.md links start at their date folder.
    const rootRelative = /^(?:\.\/)?(?:daily_problems|categories)\//.test(target);
    const url = new URL(target, rootRelative ? root : `${root}${repositoryDatePath(date)}/`);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return undefined;
    const allowedRoots = [`/${UPSTREAM.owner}/${UPSTREAM.repo}/blob/main/`, '/Yawn-Sean/Daily_CF_Problems/blob/main/'];
    if (!allowedRoots.some(path => url.pathname.startsWith(path)) || !/\.md$/i.test(url.pathname)) return undefined;
    return url.toString();
  } catch { return undefined; }
}

/** Parse both daily problems.md tables and the repository README's Today's Problem table. */
export function parseProblems(markdown: string, date: string): Problem[] {
  validateDate(date);
  const problems: Problem[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue;
    const links = markdownLinks(line);
    const problemLink = links.find(link => codeforcesProblem(link.target, link.label));
    if (!problemLink) continue;
    const parsed = codeforcesProblem(problemLink.target, problemLink.label)!;
    if (seen.has(parsed.id)) continue;
    const difficultyCell = line.slice(0, problemLink.index).split('|').map(cell => cell.trim()).find(cell => /^\*?\d{3,4}$/.test(cell));
    const rating = difficultyCell ? Number(difficultyCell.replace('*', '')) : null;
    // The asterisk marks Yawn-Sean's estimate. It is independent of whether
    // the problem comes from a Gym contest or a regular Codeforces round.
    const ratingSource: NonNullable<Problem['ratingSource']> = difficultyCell
      ? difficultyCell.startsWith('*') ? 'estimated' : 'official'
      : 'unknown';
    const editorialLink = links.find(link => link.index > problemLink.end && /(?:editorial|solution|题解)|(?:^|\/)solution\//i.test(`${link.label} ${link.target}`));
    // Slice around the known problem and editorial links, rather than splitting every pipe:
    // many hints contain unescaped absolute-value or set-builder bars inside LaTeX.
    let hint = line.slice(problemLink.end, editorialLink?.index ?? line.length).trim();
    hint = hint.replace(/^\|\s*/, '').replace(/\s*\|$/, '').trim();
    // An empty Solution column has an extra delimiter at the end of the hint.
    if (!editorialLink && /\|\s*\|\s*$/.test(line)) hint = hint.replace(/\s*\|$/, '').trim();
    const editorialUrl = editorialLink ? resolveEditorial(editorialLink.target, date) : undefined;
    problems.push({ id: parsed.id, label: problemLink.label, url: parsed.url, kind: parsed.kind, rating, ratingSource, hint,
      ...(parsed.sourceWarning ? { sourceWarning: parsed.sourceWarning } : {}), ...(editorialUrl ? { editorialUrl } : {}) });
    seen.add(parsed.id);
  }
  return problems;
}

// Synchronous SHA-256 keeps preview generation identical in Electron and browser demos.
// Its output identifies identical normalized submissions; it is not used for authentication.
function sha256(value: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bytes = encoder.encode(value);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const rotate = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits));
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const first = rotate(words[i - 15], 7) ^ rotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const second = rotate(words[i - 2], 17) ^ rotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = words[i - 16] + first + words[i - 7] + second;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + constants[i] + words[i]) | 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    for (const [i, word] of [a, b, c, d, e, f, g, h].entries()) state[i] = (state[i] + word) | 0;
  }
  return state.map(word => (word >>> 0).toString(16).padStart(8, '0')).join('');
}

export function buildSubmissionPreview(input: SubmissionInput, login = 'preview'): SubmissionPreview {
  const normalized = validateSubmission(input);
  const hash = sha256(JSON.stringify({ ...normalized, login: login.trim().toLowerCase() })).slice(0, 16);
  const language = extensionLanguageLabel(submissionExtension(normalized));
  return {
    path: submissionPath(normalized),
    title: `${normalized.date.replaceAll('-', '')} ${normalized.problemId} (${language}) - ${normalized.author}`,
    branch: `daily-cf/${normalized.date}/${normalized.problemId}-${normalized.language}-${hash}`,
    bytes: encoder.encode(normalized.code).byteLength,
    existing: false
  };
}
