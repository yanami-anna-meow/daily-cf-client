import type { GitRepository } from './git-repository';
import { PARSER_VERSION, parseProblems, repositoryDatePath, validateDate } from '../shared/domain';
import { libraryMonth, libraryProblemId, localLibraryViewInput, MAX_LIBRARY_FILE_BYTES, referenceInfo } from '../shared/library-files';
import { getLocale, t } from '../shared/i18n';
import { UPSTREAM, type ArchiveMonth, type ArchiveProgress, type ArchiveSnapshot, type LocalLibraryView, type LocalLibraryViewRequest, type Problem, type ProblemDay, type ProblemResources, type ReferenceFile } from '../shared/types';

type LibraryRepository = Pick<GitRepository, 'sync' | 'getLocalSnapshot' | 'listFiles' | 'readFile'>;
type RepositoryVersion = Awaited<ReturnType<LibraryRepository['sync']>>;
interface TreeIndex {
  months: ArchiveMonth[];
  dates: string[];
  dayOids: Map<string, string>;
  monthDates: Map<string, string[]>;
  references: Map<string, string[]>;
}
interface ParsedDay { value: Promise<Problem[]>; bytes: number; }
const MAX_INDEX_REVISIONS = 2;
const MAX_PARSED_DAYS = 8_192;
const MAX_PARSED_BYTES = 32 * 1024 * 1024;
export interface GitLibraryOptions {
  now?: () => number;
  onProgress?: (progress: ArchiveProgress) => void;
}
const missingContent = (message: string): Error => Object.assign(new Error(message), { code: 'library_content_missing' });

function checkVersion(value: RepositoryVersion): RepositoryVersion {
  if (!value || typeof value !== 'object' || typeof value.branch !== 'string' || !value.branch ||
    value.branch === '@' || /[\x00-\x20\x7f~^:?*\[\\]/.test(value.branch) || value.branch.includes('..') ||
    value.branch.includes('@{') || value.branch.endsWith('.') ||
    value.branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')) ||
    typeof value.revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.revision)) {
    throw new Error(t('无法确认题库当前版本，请刷新后重试。'));
  }
  return { branch: value.branch, revision: value.revision };
}

/** Repository files are read from immutable Git objects, never from a checkout.
 * Each independent read first synchronizes the remote. A full archive load may
 * explicitly reuse one snapshot so its months cannot mix different revisions.
 */
export class GitProblemLibrary {
  private readonly now: () => number;
  private readonly indexes = new Map<string, Promise<TreeIndex>>();
  private readonly parsedDays = new Map<string, ParsedDay>();
  private parsedBytes = 0;

  constructor(private readonly repository: LibraryRepository, private readonly options: GitLibraryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async syncLibrary(): Promise<RepositoryVersion> {
    // A failed synchronization is always surfaced. The previous local revision
    // must not silently turn an unsuccessful refresh into a successful read.
    return checkVersion(await this.repository.sync());
  }

  /** A distinct preview API: it never synchronizes or reports a successful
   * update. Every file in the result comes from the same existing commit.
   */
  async getLocalLibraryView(value: LocalLibraryViewRequest): Promise<LocalLibraryView | null> {
    const request = localLibraryViewInput(value);
    const local = await this.repository.getLocalSnapshot();
    if (!local) return null;
    const version = checkVersion(local);
    const { revision } = version;
    if (request.kind === 'day') {
      const date = request.date ?? (await this.index(revision)).dates[0];
      if (!date) return null;
      try { return { kind: 'day', revision, day: await this.dayAt(date, revision) }; }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'library_content_missing') return null; throw error; }
    }
    if (request.kind === 'archive') {
      const index = await this.index(revision);
      const snapshot = { ...version, months: index.months.map(month => ({ ...month })) };
      const month = request.month ?? snapshot.months[0]?.month ?? '';
      const days = month ? await this.getMonthFromSnapshot(month, snapshot) : [];
      if (request.scope === 'month') return { kind: 'archive', revision, snapshot, month, days };
      const archiveIndex: Record<string, ProblemDay[]> = {};
      for (const entry of snapshot.months) {
        archiveIndex[entry.month] = entry.month === month ? days : await this.getMonthFromSnapshot(entry.month, snapshot);
      }
      return { kind: 'archive', revision, snapshot, month, days, index: archiveIndex };
    }
    if (request.kind === 'resources') {
      return { kind: 'resources', revision, resources: await this.resourcesAt(request.date, request.problemId, revision) };
    }
    try { return { kind: 'reference', revision, code: await this.referenceAt(request.path, revision) }; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'library_content_missing') return null; throw error; }
  }

  private async index(revision: string): Promise<TreeIndex> {
    const existing = this.indexes.get(revision);
    if (existing) {
      this.indexes.delete(revision);
      this.indexes.set(revision, existing);
      return existing;
    }
    const value = this.buildIndex(revision);
    this.indexes.set(revision, value);
    // Old local preview and newly synchronized reads can run together. Keep
    // both immutable directory indexes without retaining an unbounded history.
    while (this.indexes.size > MAX_INDEX_REVISIONS) this.indexes.delete(this.indexes.keys().next().value!);
    try { return await value; }
    catch (error) {
      if (this.indexes.get(revision) === value) this.indexes.delete(revision);
      throw error;
    }
  }

  private async buildIndex(revision: string): Promise<TreeIndex> {
    const files = await this.repository.listFiles(revision);
    const months = new Set<string>();
    const dayOids = new Map<string, string>();
    const references = new Map<string, string[]>();
    for (const file of files) {
      // The repository already excludes links. Keep the boundary explicit so
      // alternate repository implementations cannot expose one as source code.
      if (file.mode !== '100644' && file.mode !== '100755') continue;
      const monthPath = /^daily_problems\/(\d{4})\/(\d{2})\//.exec(file.path);
      if (!monthPath) continue;
      let month: string;
      try { month = libraryMonth(`${monthPath[1]}-${monthPath[2]}`); } catch { continue; }
      months.add(month);
      const dayPath = /^daily_problems\/(\d{4})\/(\d{2})\/(\d{4})\/problems\.md$/.exec(file.path);
      if (dayPath && dayPath[2] === dayPath[3].slice(0, 2)) {
        try { dayOids.set(validateDate(`${month}-${dayPath[3].slice(2)}`), file.oid); } catch { /* Ignore malformed repository folders. */ }
      }
      // Only direct children belong to the code list. Reference reads validate
      // the solution path and content; an unfamiliar suffix is not a reason to hide it.
      const reference = /^(daily_problems\/\d{4}\/\d{2}\/\d{4})\/personal_submission\/([^/]+)$/.exec(file.path);
      if (reference) {
        const paths = references.get(reference[1]) ?? [];
        paths.push(file.path);
        references.set(reference[1], paths);
      }
    }
    const dates = [...dayOids.keys()].sort().reverse();
    const monthDates = new Map<string, string[]>();
    for (const date of dates) {
      const month = date.slice(0, 7);
      const datesInMonth = monthDates.get(month) ?? [];
      datesInMonth.push(date);
      monthDates.set(month, datesInMonth);
    }
    return {
      months: [...months].sort().reverse().map(month => ({ month, days: monthDates.get(month)?.length ?? 0 })),
      dates, dayOids, monthDates, references,
    };
  }

  private sourceUrl(path: string, revision: string): string {
    return `${UPSTREAM.url}/blob/${encodeURIComponent(revision)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async dayAt(date: string, revision: string): Promise<ProblemDay> {
    const path = `${repositoryDatePath(date)}/problems.md`;
    // Consult the requested revision first: an older retained parse must never
    // resurrect a deleted file or a file replaced by a symbolic link.
    const oid = (await this.index(revision)).dayOids.get(date);
    if (!oid) throw missingContent(t('仓库中没有 {{date}} 的题单，请刷新后重新选择日期。', { date }));
    const problems = await this.parsedAt(date, path, oid, revision);
    return {
      date, parserVersion: PARSER_VERSION, problems: problems.map(problem => ({ ...problem })),
      sourceUrl: this.sourceUrl(path, revision), fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  private forgetParsed(key: string): void {
    const entry = this.parsedDays.get(key);
    if (!entry) return;
    this.parsedDays.delete(key);
    this.parsedBytes -= entry.bytes;
  }

  private trimParsed(): void {
    while (this.parsedDays.size > MAX_PARSED_DAYS || this.parsedBytes > MAX_PARSED_BYTES) {
      this.forgetParsed(this.parsedDays.keys().next().value!);
    }
  }

  private async parsedAt(date: string, path: string, oid: string, revision: string): Promise<Problem[]> {
    const locale = getLocale();
    // File identity, parser schema, date-relative links and localized warnings
    // all affect the result. The commit itself does not when this blob is equal.
    const key = `${PARSER_VERSION}/${locale}/${date}/${oid}`;
    const previous = this.parsedDays.get(key);
    if (previous) {
      this.parsedDays.delete(key);
      this.parsedDays.set(key, previous);
      return previous.value;
    }
    const entry: ParsedDay = { value: undefined!, bytes: 0 };
    this.parsedDays.set(key, entry);
    // Retain the pending promise too: simultaneous local preview and fresh
    // reads of the same blob share both the disk read and the parser work.
    entry.value = (async () => {
      try {
        const markdown = await this.repository.readFile(revision, path, MAX_LIBRARY_FILE_BYTES);
        if (markdown === null) throw missingContent(t('仓库中没有 {{date}} 的题单，请刷新后重新选择日期。', { date }));
        const problems = parseProblems(markdown, date);
        if (this.parsedDays.get(key) === entry) {
          // The worker may receive a language change while the read awaits I/O.
          // Never retain the result under a language it was not parsed with.
          if (getLocale() !== locale) this.forgetParsed(key);
          else {
            entry.bytes = Buffer.byteLength(JSON.stringify(problems), 'utf8');
            this.parsedBytes += entry.bytes;
            this.trimParsed();
          }
        }
        return problems;
      } catch (error) {
        if (this.parsedDays.get(key) === entry) this.forgetParsed(key);
        throw error;
      }
    })();
    this.trimParsed();
    return entry.value;
  }

  async getDay(value?: string, _refresh = false): Promise<ProblemDay> {
    const requested = value === undefined ? undefined : validateDate(value);
    const { revision } = await this.syncLibrary();
    const date = requested ?? (await this.index(revision)).dates[0];
    if (!date) throw missingContent(t('仓库中暂未找到每日题单。'));
    return this.dayAt(date, revision);
  }

  async getArchiveMonths(_refresh = false): Promise<ArchiveMonth[]> {
    return (await this.getArchiveSnapshot()).months;
  }

  async getArchiveSnapshot(): Promise<ArchiveSnapshot> {
    const version = await this.syncLibrary();
    const index = await this.index(version.revision);
    // Avoid returning the internal index: renderer-side filtering or fixture
    // callers must not mutate the next independently synchronized result.
    return { ...version, months: index.months.map(month => ({ ...month })) };
  }

  async getMonth(value: string, _refresh = false): Promise<ProblemDay[]> {
    const month = libraryMonth(value);
    const version = await this.syncLibrary();
    return this.getMonthFromSnapshot(month, { ...version, months: [] });
  }

  async getMonthFromSnapshot(value: string, snapshot: ArchiveSnapshot): Promise<ProblemDay[]> {
    const month = libraryMonth(value);
    const { revision } = checkVersion(snapshot);
    const dates = (await this.index(revision)).monthDates.get(month) ?? [];
    const days: ProblemDay[] = [];
    // Local reads are sequential, keeping decompression memory bounded. This
    // work runs outside the UI process; the caller publishes archive progress.
    for (const date of dates) {
      days.push(await this.dayAt(date, revision));
      this.options.onProgress?.({ month, completed: days.length, total: dates.length });
    }
    return days;
  }

  async getResources(value: string, id: string, _refresh = false): Promise<ProblemResources> {
    const date = validateDate(value);
    const problemId = libraryProblemId(id);
    const { revision } = await this.syncLibrary();
    return this.resourcesAt(date, problemId, revision);
  }

  private async resourcesAt(date: string, problemId: string, revision: string): Promise<ProblemResources> {
    const base = repositoryDatePath(date);
    const editorialPath = `${base}/solution/${problemId}.md`;
    const [editorial, index] = await Promise.all([
      this.repository.readFile(revision, editorialPath, MAX_LIBRARY_FILE_BYTES), this.index(revision),
    ]);
    const references: ReferenceFile[] = (index.references.get(base) ?? []).flatMap(path => {
      if (!path.startsWith(`${base}/personal_submission/${problemId}_`)) return [];
      try {
        const info = referenceInfo(path);
        return [{ name: info.name, path, language: info.language, url: this.sourceUrl(path, revision) }];
      } catch { return []; }
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { editorial, editorialUrl: editorial === null ? null : this.sourceUrl(editorialPath, revision), references };
  }

  async getReference(path: string, _refresh = false): Promise<string> {
    referenceInfo(path);
    const { revision } = await this.syncLibrary();
    return this.referenceAt(path, revision);
  }

  private async referenceAt(path: string, revision: string): Promise<string> {
    const text = await this.repository.readFile(revision, path, MAX_LIBRARY_FILE_BYTES);
    if (text === null) throw missingContent(t('参考代码不存在，请刷新后重试。'));
    if (text.includes('\0')) throw new Error(t('该文件不是可预览的文本代码。'));
    return text;
  }
}
