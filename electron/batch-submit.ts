import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { submissionPath, validateSubmission } from '../shared/domain';
import { t } from '../shared/i18n';
import {
  UPSTREAM, type BatchSubmissionInput, type BatchSubmissionPreview, type BatchSubmissionResult,
  type ForkSyncStatus, type Problem, type ProblemDay, type SubmissionInput, type SubmissionProgress, type User,
} from '../shared/types';

const UPSTREAM_NAME = `${UPSTREAM.owner}/${UPSTREAM.repo}`.toLowerCase();
const UPSTREAM_PATH = `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}`;
const segment = encodeURIComponent;
const encodePath = (path: string) => path.split('/').map(segment).join('/');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const branchPattern = /^daily-cf\/batch\/\d{4}-\d{2}-\d{2}-[a-f0-9]{16}(?:-r\d+)*$/;

export interface BatchRepository {
  id?: number;
  name: string; full_name: string; default_branch: string; fork: boolean;
  owner: { login: string }; parent?: { full_name: string }; source?: { full_name: string };
}

/** Bound main-process capabilities; this module never receives or handles credentials. */
export interface BatchAdapter {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  optional<T>(path: string): Promise<T | null>;
  getUser(): Promise<User>;
  getUpstream(fresh?: boolean): Promise<BatchRepository>;
  dayAt(date: string, ref?: string): Promise<ProblemDay>;
  resolveExistingFork(login: string): Promise<BatchRepository | null>;
  ensureFork(login: string): Promise<BatchRepository>;
  inspectForkSync(fork: BatchRepository, upstream: BatchRepository, baseSha: string): Promise<ForkSyncStatus>;
  syncFork(fork: BatchRepository, upstream: BatchRepository, baseSha: string): Promise<ForkSyncStatus>;
  assertForkCurrent(fork: BatchRepository, upstream: BatchRepository, baseSha: string): Promise<unknown>;
  renderBatch(input: BatchSubmissionInput, login: string, problems: Problem[]): { title: string; body: string };
  error(message: string, status?: number): Error;
}

interface Reference { object: { sha: string } }
interface File { type: string; encoding: string; content: string; sha: string }
interface GitCommit { sha: string; tree: { sha: string }; parents: { sha: string }[]; message: string }
interface ChangedFile { filename: string; previous_filename?: string; status?: string }
interface Pull {
  number: number; title: string; body: string | null; state: 'open' | 'closed'; merged_at: string | null;
  created_at: string; updated_at?: string; user?: { login: string };
  head: { ref: string; sha: string; user?: { login: string } | null; repo: BatchRepository | null };
  base: { ref: string; repo: BatchRepository };
}
interface Item { input: SubmissionInput; path: string; problem: Problem; existing: File | null }
interface Prepared {
  input: BatchSubmissionInput; login: string; upstream: BatchRepository; baseSha: string;
  fork: BatchRepository | null; items: Item[]; branch: string; pathHash: string; payloadHash: string;
  forkSync?: ForkSyncStatus;
  title: string; body: string;
}
type Progress = (progress: SubmissionProgress) => void;

/** Writes immutable Git objects first and publishes the complete batch with one ref update. */
export class BatchSubmissionEngine {
  constructor(private readonly adapter: BatchAdapter) {}

  private fail(message: string): never { throw this.adapter.error(message); }

  private normalize(raw: BatchSubmissionInput): BatchSubmissionInput {
    if (!raw || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 50) {
      this.fail(t('每次提交请选择 1–50 个代码文件。'));
    }
    if (raw.target !== undefined && (!raw.target || raw.target.kind !== 'new')) this.fail(t('提交目标无效，请重新选择“新建 PR”并预览。'));
    if (typeof raw.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(raw.requestId)) {
      this.fail(t('本次提交标识无效，请重新打开提交窗口后预览；网络重试须保留原提交标识。'));
    }
    if (typeof raw.notes !== 'string' || raw.notes.trim().length > 2000) this.fail(t('批量提交说明须为不超过 2000 个字符的文本。'));
    const items = raw.items.map(validateSubmission).sort((left, right) => submissionPath(left).localeCompare(submissionPath(right), 'en'));
    const paths = items.map(submissionPath);
    if (new Set(paths).size !== paths.length) this.fail(t('批量提交包含重复的目标文件，请调整题目、扩展名或署名。'));
    let overwrites: BatchSubmissionInput['overwrites'];
    if (raw.overwrites !== undefined) {
      if (!Array.isArray(raw.overwrites) || raw.overwrites.length > 50) this.fail(t('覆盖确认列表格式不正确或超过 50 个文件。'));
      const confirmed = new Set<string>();
      overwrites = raw.overwrites.map(entry => {
        if (!entry || typeof entry.path !== 'string' || !paths.includes(entry.path)) this.fail(t('覆盖确认路径必须是本次提交的规范文件路径。'));
        if (confirmed.has(entry.path)) this.fail(t('覆盖确认列表不能包含重复文件路径。'));
        if (typeof entry.sha !== 'string' || !/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(entry.sha)) this.fail(t('覆盖确认的文件版本无效，请重新预览后确认。'));
        confirmed.add(entry.path);
        return { path: entry.path, sha: entry.sha.toLowerCase() };
      });
    }
    if (items.reduce((bytes, item) => bytes + Buffer.byteLength(item.code), 0) > 5 * 1024 * 1024) this.fail(t('本次批量代码总大小不能超过 5 MiB。'));
    if ([raw.notes, ...items.map(item => item.notes)].some(notes => /<!--\s*daily-cf-/i.test(notes))) this.fail(t('提交说明包含客户端保留标记，请删除 daily-cf 注释。'));
    return { items, notes: raw.notes.trim(), target: { kind: 'new' }, requestId: raw.requestId, ...(overwrites !== undefined ? { overwrites } : {}) };
  }

  private repositoryPath(repository: BatchRepository): string {
    return `/repos/${segment(repository.owner.login)}/${segment(repository.name)}`;
  }

  private assertFork(repository: BatchRepository, login: string): void {
    if (!/^[\w.-]+$/.test(repository.name) || repository.owner.login.toLowerCase() !== login.toLowerCase() ||
      repository.full_name.toLowerCase() !== `${login}/${repository.name}`.toLowerCase()) this.fail(t('批量提交的来源仓库与当前账号不匹配。'));
    if (repository.full_name.toLowerCase() === UPSTREAM_NAME && UPSTREAM.owner.toLowerCase() === login.toLowerCase()) return;
    if (!repository.fork || ![repository.parent?.full_name, repository.source?.full_name].some(name => name?.toLowerCase() === UPSTREAM_NAME)) {
      this.fail(t('批量提交的来源仓库不是可信的个人 Fork，已停止操作。'));
    }
  }

  private async file(repositoryPath: string, path: string, sha: string): Promise<File | null> {
    const file = await this.adapter.optional<File | File[]>(`${repositoryPath}/contents/${encodePath(path)}?ref=${segment(sha)}`);
    if (file && (Array.isArray(file) || file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || !file.sha)) {
      this.fail(t('目标路径不是可读取的普通代码文件：{{path}}', { path }));
    }
    return file as File | null;
  }

  private decode(file: File): string { return Buffer.from(file.content, 'base64').toString('utf8'); }
  private unchanged(file: File, code: string): boolean {
    return Buffer.from(file.content, 'base64').equals(Buffer.from(code, 'utf8'));
  }
  private previous(file: File): NonNullable<BatchSubmissionPreview['items'][number]['previous']> {
    const bytes = Buffer.from(file.content, 'base64');
    const limit = 256 * 1024;
    // Streaming decoding leaves a partial last UTF-8 character out of the preview
    // instead of inserting a replacement character at the truncation boundary.
    // Preserve an actual BOM and CRLF; the acknowledgement covers these exact bytes.
    try {
      const code = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, limit), { stream: bytes.length > limit });
      return { sha: file.sha, code, bytes: bytes.length, truncated: bytes.length > limit };
    } catch {
      this.fail(t('旧文件不是可准确展示的 UTF-8 文本，请先在 GitHub 检查该文件后再提交。'));
    }
  }
  private contentHash(items: { path: string; code: string }[]): string {
    return digest(items.map(item => [item.path, item.code]).sort((left, right) => left[0].localeCompare(right[0], 'en')));
  }
  private desiredContent(prepared: Prepared): string {
    return this.contentHash(prepared.items.map(item => ({ path: item.path, code: item.input.code })));
  }
  private body(prepared: Prepared, branch: string): string {
    return `${prepared.body}\n\n<!-- daily-cf-client:${branch} -->\n<!-- daily-cf-payload:${prepared.branch} -->\n<!-- daily-cf-batch-paths:${prepared.pathHash} -->`;
  }
  private commitMessage(prepared: Prepared, branch: string): string {
    return `${prepared.title}\n\n[daily-cf-client:${branch}]\n[daily-cf-batch-paths:${prepared.pathHash}]\n[daily-cf-batch-content:${this.desiredContent(prepared)}]`;
  }

  private async prepare(raw: BatchSubmissionInput, expectedLogin?: string): Promise<Prepared> {
    const input = this.normalize(raw);
    const user = await this.adapter.getUser();
    if (expectedLogin && user.login.toLowerCase() !== expectedLogin.toLowerCase()) this.fail(t('登录账号已发生变化，请重新预览后提交。'));
    const upstream = await this.adapter.getUpstream(true);
    if (upstream.full_name.toLowerCase() !== UPSTREAM_NAME || !upstream.default_branch) this.fail(t('上游仓库信息异常，已停止批量提交。'));
    const fork = await this.adapter.resolveExistingFork(user.login);
    if (fork) this.assertFork(fork, user.login);
    const reference = await this.adapter.request<Reference>(`${UPSTREAM_PATH}/git/ref/heads/${segment(upstream.default_branch)}`);
    const baseSha = reference.object.sha;
    const forkSync = fork ? await this.adapter.inspectForkSync(fork, upstream, baseSha) : undefined;
    const days = new Map<string, ProblemDay>();
    for (const date of new Set(input.items.map(item => item.date))) days.set(date, await this.adapter.dayAt(date, baseSha));
    const items: Item[] = [];
    for (const item of input.items) {
      const problem = days.get(item.date)!.problems.find(problem => problem.id === item.problemId);
      if (!problem) this.fail(t('{{date}} 的题单不包含 {{problem}}，请刷新题目后重新选择。', { date: item.date, problem: item.problemId.toUpperCase() }));
      const path = submissionPath(item);
      items.push({ input: item, path, problem, existing: await this.file(UPSTREAM_PATH, path, baseSha) });
    }
    const changed = items.filter(item => !item.existing || !this.unchanged(item.existing, item.input.code));
    // The queue retains unchanged entries for review, but a new PR's description
    // should describe files that actually differ. With no changes the preview
    // remains readable; submit rejects the empty diff before any writes.
    const templateItems = changed.length ? changed : items;
    const rendered = this.adapter.renderBatch({ ...input, items: templateItems.map(item => item.input) }, user.login, templateItems.map(item => item.problem));
    if (/<!--\s*daily-cf-/i.test(rendered.title + rendered.body)) this.fail(t('PR 模板包含客户端保留标记。'));
    // Consent is a version precondition, not part of what is being submitted.
    // Preview, confirmation and a retry without its old ACK share one identity.
    const { overwrites: _overwrites, ...semanticInput } = input;
    const payloadHash = digest({ login: user.login.toLowerCase(), input: semanticInput });
    const pathHash = digest(items.map(item => item.path));
    const firstDate = [...input.items.map(item => item.date)].sort()[0];
    return { input, login: user.login, upstream, baseSha, fork, forkSync, items, pathHash, payloadHash,
      branch: `daily-cf/batch/${firstDate}-${payloadHash.slice(0, 16)}`, title: rendered.title, body: rendered.body };
  }

  async preview(raw: BatchSubmissionInput): Promise<BatchSubmissionPreview> {
    const prepared = await this.prepare(raw);
    const items = prepared.items.map(({ input, path, problem, existing }) => ({
      date: input.date, problemId: input.problemId, language: input.language, extension: input.extension, author: input.author,
      path, bytes: Buffer.byteLength(input.code), existing: Boolean(existing), problem,
      unchanged: Boolean(existing && this.unchanged(existing, input.code)),
      ...(existing ? { previous: this.previous(existing) } : {}),
    }));
    return { items, title: prepared.title, body: this.body(prepared, prepared.branch), branch: prepared.branch,
      bytes: items.reduce((bytes, item) => bytes + item.bytes, 0), ...(prepared.fork ? { forkRepository: prepared.fork.full_name } : {}),
      ...(prepared.forkSync ? { forkSync: prepared.forkSync } : {}) };
  }

  private changedPaths(prepared: Prepared): string[] {
    return prepared.items.filter(item => !item.existing || !this.unchanged(item.existing, item.input.code)).map(item => item.path);
  }

  private assertChanges(files: ChangedFile[] | undefined, prepared: Prepared, paths = this.changedPaths(prepared)): void {
    if (!files || files.length !== paths.length || new Set(files.map(file => file.filename)).size !== files.length ||
      files.some(file => !paths.includes(file.filename) || file.previous_filename || !['added', 'modified'].includes(file.status ?? ''))) {
      this.fail(t('批量提交分支的实际文件变更与预览不一致，或包含其他修改，已停止操作。'));
    }
  }

  private async pullFiles(pull: Pull): Promise<ChangedFile[]> {
    // At most 50 allowed files; a full 100-entry page is necessarily unrelated work.
    const files = await this.adapter.request<ChangedFile[]>(`${UPSTREAM_PATH}/pulls/${pull.number}/files?per_page=100`);
    if (files.length >= 100) this.fail(t('客户端 PR #{{number}} 的文件数量异常，无法确认完整变更，请先在 GitHub 检查。', { number: pull.number }));
    return files;
  }

  private assertPull(pull: Pull, prepared: Prepared, repository: BatchRepository, branch: string, sha?: string): void {
    if (!Number.isSafeInteger(pull.number) || pull.number <= 0 || !branchPattern.test(branch) || pull.head.ref !== branch ||
      pull.head.user?.login?.toLowerCase() !== prepared.login.toLowerCase() ||
      (pull.user && pull.user.login.toLowerCase() !== prepared.login.toLowerCase()) ||
      !pull.head.repo || pull.head.repo.full_name.toLowerCase() !== repository.full_name.toLowerCase() ||
      ((pull.head.repo.id !== undefined || repository.id !== undefined) && pull.head.repo.id !== repository.id) ||
      pull.head.repo.owner.login.toLowerCase() !== prepared.login.toLowerCase() ||
      pull.base.repo.full_name.toLowerCase() !== UPSTREAM_NAME || pull.base.ref !== prepared.upstream.default_branch ||
      !pull.body?.includes(`<!-- daily-cf-client:${branch} -->`) ||
      !pull.body.includes(`<!-- daily-cf-batch-paths:${prepared.pathHash} -->`) || (sha && pull.head.sha !== sha)) {
      this.fail(t('已有 Pull Request 的来源、目标或客户端标记不匹配，已停止批量提交。'));
    }
  }

  private async inspect(
    prepared: Prepared, repository: BatchRepository, branch: string, sha: string, expectedContent?: string, compareUpstream = true,
  ): Promise<{ commit: GitCommit; contentHash: string }> {
    if (!branchPattern.test(branch) || branch === repository.default_branch) this.fail(t('拒绝写入非客户端分支或默认分支。'));
    const path = this.repositoryPath(repository);
    const commit = await this.adapter.request<GitCommit>(`${path}/git/commits/${segment(sha)}`);
    if (compareUpstream) {
      const comparison = await this.adapter.request<{ files?: ChangedFile[] }>(`${path}/compare/${segment(prepared.baseSha)}...${segment(sha)}`);
      this.assertChanges(comparison.files, prepared);
    }
    const contents: { path: string; code: string }[] = [];
    for (const item of prepared.items) {
      const current = await this.file(path, item.path, sha);
      if (!current) this.fail(t('批量提交文件不可读取：{{path}}', { path: item.path }));
      contents.push({ path: item.path, code: this.decode(current) });
    }
    const contentHash = this.contentHash(contents);
    if (commit.sha !== sha || !commit.message.includes(`[daily-cf-client:${branch}]`) ||
      !commit.message.includes(`[daily-cf-batch-paths:${prepared.pathHash}]`) ||
      !commit.message.includes(`[daily-cf-batch-content:${contentHash}]`) || (expectedContent && contentHash !== expectedContent)) {
      this.fail(t('批量提交分支已在其他地方修改，或内容标记不匹配。为保护已有修改，已停止操作。'));
    }
    return { commit, contentHash };
  }

  private async branchPull(prepared: Prepared, branch: string): Promise<Pull | null> {
    const pulls = await this.adapter.request<Pull[]>(`${UPSTREAM_PATH}/pulls?state=all&head=${segment(`${prepared.login}:${branch}`)}&base=${segment(prepared.upstream.default_branch)}&per_page=100&sort=created&direction=desc`);
    const matching = pulls.filter(pull => {
      if (pull.head.ref !== branch) return false;
      const sourceLogin = pull.head.user?.login ?? pull.head.repo?.owner.login;
      return sourceLogin ? sourceLogin.toLowerCase() === prepared.login.toLowerCase()
        : pull.user?.login.toLowerCase() === prepared.login.toLowerCase();
    });
    if (matching.some(pull => !pull.head.repo || !pull.head.user?.login)) this.fail(t('已有 Pull Request 的来源 Fork 已删除或账号信息缺失，不能将同名新仓库当作原提交，请先在 GitHub 检查。'));
    if (matching.some(pull => !pull.body?.includes(`<!-- daily-cf-client:${branch} -->`))) this.fail(t('同名批量提交分支已关联其他 Pull Request，已停止操作。'));
    return matching.find(pull => pull.state === 'open' && !pull.merged_at) ?? matching[0] ?? null;
  }

  private rejectUnchanged(prepared: Prepared): void {
    if (!this.changedPaths(prepared).length) this.fail(t('列表中的代码均与上游相同，没有可创建 Pull Request 的文件变更。'));
  }

  private async assertUnpublishedBase(prepared: Prepared, repository: BatchRepository, sha: string): Promise<void> {
    const commit = await this.adapter.request<GitCommit>(`${this.repositoryPath(repository)}/git/commits/${segment(sha)}`);
    // A failed PR request can leave an immutable published branch. GitHub's
    // three-dot comparison starts at the merge base, so its diff alone cannot
    // prove that this orphan branch still starts from the current upstream.
    if (commit.sha !== sha || commit.parents?.length !== 1 || commit.parents[0].sha !== prepared.baseSha) {
      throw Object.assign(this.adapter.error(t('上游已更新，先前未完成的提交分支仍保留。请重新预览，以最新上游创建新的提交。')),
        { code: 'submission_base_changed' });
    }
  }

  private confirmOverwrites(prepared: Prepared): void {
    const confirmations = new Map(prepared.input.overwrites?.map(entry => [entry.path, entry.sha]));
    for (const item of prepared.items) {
      if (!item.existing || this.unchanged(item.existing, item.input.code)) continue;
      const confirmed = confirmations.get(item.path);
      if (!confirmed) this.fail(t('文件 {{path}} 已存在。请在预览中查看旧代码并明确确认覆盖后再提交。', { path: item.path }));
      if (confirmed !== item.existing.sha.toLowerCase()) this.fail(t('文件 {{path}} 的旧代码已发生变化。请重新预览并确认覆盖最新版本后再提交。', { path: item.path }));
    }
  }

  private async immutablePost<T>(path: string, body: unknown): Promise<T> {
    try { return await this.adapter.request<T>(path, 'POST', body); }
    catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      if (status && status < 500) throw error;
      // These are content-addressed objects, never refs. Retrying the identical object
      // cannot publish a partial batch or overwrite an existing branch.
      return this.adapter.request<T>(path, 'POST', body);
    }
  }

  private async createCommit(prepared: Prepared, repository: BatchRepository, branch: string, parent: string): Promise<string> {
    const path = this.repositoryPath(repository);
    const base = await this.adapter.request<GitCommit>(`${path}/git/commits/${segment(parent)}`);
    if (base.sha !== parent || !base.tree?.sha) this.fail(t('无法确认批量提交的基础 Git 树。'));
    const tree: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const item of prepared.items) {
      if (item.existing && this.unchanged(item.existing, item.input.code)) continue;
      const blob = await this.immutablePost<{ sha: string }>(`${path}/git/blobs`, { content: item.input.code, encoding: 'utf-8' });
      const bytes = Buffer.from(item.input.code);
      const expected = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (blob.sha !== expected) this.fail(t('GitHub 返回的代码对象校验值不匹配，尚未发布分支。'));
      tree.push({ path: item.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const createdTree = await this.immutablePost<{ sha: string }>(`${path}/git/trees`, { base_tree: base.tree.sha, tree });
    // Fix identity and timestamp in the request so an uncertain POST can be retried
    // as exactly the same immutable commit instead of an extra visible revision.
    const identity = { name: prepared.login, email: `${prepared.login}@users.noreply.github.com`, date: new Date().toISOString() };
    const message = this.commitMessage(prepared, branch);
    const commit = await this.immutablePost<GitCommit>(`${path}/git/commits`, {
      message, tree: createdTree.sha, parents: [parent], author: identity, committer: identity,
    });
    if (!commit.sha || commit.tree?.sha !== createdTree.sha || commit.parents?.length !== 1 || commit.parents[0].sha !== parent || commit.message !== message) {
      this.fail(t('GitHub 返回的批量提交对象与预期不符，尚未发布分支。'));
    }
    await this.inspect(prepared, repository, branch, commit.sha, this.desiredContent(prepared));
    return commit.sha;
  }

  private async publish(prepared: Prepared, repository: BatchRepository, branch: string, sha: string): Promise<void> {
    if (branch === repository.default_branch || !branchPattern.test(branch)) this.fail(t('拒绝修改默认分支或非客户端分支。'));
    await this.adapter.assertForkCurrent(repository, prepared.upstream, prepared.baseSha);
    const path = this.repositoryPath(repository);
    const refPath = `${path}/git/ref/heads/${segment(branch)}`;
    const before = await this.adapter.optional<Reference>(refPath);
    if (before?.object.sha === sha) return;
    if (before) this.fail(t('提交分支已发生并发变化，已保留远端修改，请刷新后重试。'));
    try {
      await this.adapter.request(`${path}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha });
    } catch (error) {
      const recovered = await this.adapter.optional<Reference>(refPath);
      if (recovered?.object.sha !== sha) throw error;
    }
    const after = await this.adapter.request<Reference>(refPath);
    if (after.object.sha !== sha) this.fail(t('批量提交分支在发布时发生变化，请刷新后重试。'));
    await this.inspect(prepared, repository, branch, sha, this.desiredContent(prepared));
  }

  private result(pull: Pull, prepared: Prepared, reused: boolean, paths: string[]): BatchSubmissionResult {
    return { reused, record: {
      id: `${UPSTREAM_NAME}#${pull.number}`, number: pull.number, title: pull.title,
      url: `${UPSTREAM.url}/pull/${pull.number}`, state: pull.merged_at ? 'merged' : pull.state,
      createdAt: pull.created_at, updatedAt: pull.updated_at ?? pull.created_at,
      problems: prepared.items.filter(item => paths.includes(item.path)).map(({ input, path }) => ({ date: input.date, problemId: input.problemId, language: input.language, path })),
      filesTruncated: false,
    } };
  }

  private async withSyncedFork<T>(prepared: Prepared, repository: BatchRepository, action: () => Promise<T>): Promise<T> {
    await this.adapter.syncFork(repository, prepared.upstream, prepared.baseSha);
    try {
      return await action();
    } catch (error) {
      if (prepared.forkSync?.state === 'behind' && repository.full_name.toLowerCase() !== UPSTREAM_NAME) {
        const message = error instanceof Error ? error.message : t('后续提交状态尚未确认，请刷新后重试。');
        const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
        throw Object.assign(this.adapter.error(t('个人 Fork 默认分支已同步至上游；后续提交步骤未完成确认。{{message}}', { message }), status),
          error && typeof error === 'object' && 'code' in error && error.code === 'submission_base_changed' ? { code: error.code } : {});
      }
      throw error;
    }
  }

  private async recoverNew(pull: Pull, prepared: Prepared, repository: BatchRepository, reused: boolean, expectedSha?: string): Promise<BatchSubmissionResult> {
    // An explicit new submission may only recover its own request and payload.
    // It never edits another PR, including metadata someone changed after creation.
    const latest = await this.adapter.request<Pull>(`${UPSTREAM_PATH}/pulls/${pull.number}`);
    this.assertPull(latest, prepared, repository, prepared.branch, expectedSha);
    if (!latest.body?.includes(`<!-- daily-cf-payload:${prepared.branch} -->`)) this.fail(t('已有 PR 与本次提交标识不一致，请检查 GitHub 后重新提交。'));
    const { commit } = await this.inspect(prepared, repository, prepared.branch, latest.head.sha, this.desiredContent(prepared), false);
    // Recover this immutable request against its original parent, not today's
    // upstream. Some unchanged queue entries never belonged to the PR diff.
    if (commit.parents.length !== 1) this.fail(t('无法确认批量提交的基础 Git 树。'));
    const repositoryPath = this.repositoryPath(repository);
    const paths: string[] = [];
    for (const item of prepared.items) {
      const original = await this.file(repositoryPath, item.path, commit.parents[0].sha);
      if (!original || !this.unchanged(original, item.input.code)) paths.push(item.path);
    }
    const comparison = await this.adapter.request<{ files?: ChangedFile[] }>(`${repositoryPath}/compare/${segment(commit.parents[0].sha)}...${segment(latest.head.sha)}`);
    this.assertChanges(comparison.files, prepared, paths);
    this.assertChanges(await this.pullFiles(latest), prepared, paths);
    if (latest.state === 'open' && !latest.merged_at) {
      const reference = await this.adapter.request<Reference>(`${this.repositoryPath(repository)}/git/ref/heads/${segment(prepared.branch)}`);
      if (reference.object.sha !== latest.head.sha) this.fail(t('提交分支已发生变化，请刷新后重试。'));
    }
    return this.result(latest, prepared, reused, paths);
  }

  async submit(raw: BatchSubmissionInput, login: string, progress: Progress = () => {}): Promise<BatchSubmissionResult> {
    progress({ stage: 'validating', message: t('正在核对批量题目、登录账号和最新上游版本…') });
    const prepared = await this.prepare(raw, login);
    const branch = prepared.branch;
    const prior = await this.branchPull(prepared, branch);
    if (prior) {
      if (!prepared.fork) this.fail(t('本次提交的来源 Fork 不可用，请重新绑定后重试。'));
      const recovered = await this.recoverNew(prior, prepared, prepared.fork, true);
      progress({ stage: 'complete', message: t('已恢复本次提交对应的 Pull Request。') });
      return recovered;
    }
    if (prepared.fork) {
      const orphan = await this.adapter.optional<Reference>(`${this.repositoryPath(prepared.fork)}/git/ref/heads/${segment(branch)}`);
      if (orphan) await this.assertUnpublishedBase(prepared, prepared.fork, orphan.object.sha);
    }
    this.confirmOverwrites(prepared);
    this.rejectUnchanged(prepared);
    progress({ stage: 'forking', message: t('正在确认批量提交使用的个人 Fork…') });
    const repository = await this.adapter.ensureFork(prepared.login);
    this.assertFork(repository, prepared.login);
    if (prepared.fork && (prepared.fork.full_name.toLowerCase() !== repository.full_name.toLowerCase() ||
      ((prepared.fork.id !== undefined || repository.id !== undefined) && prepared.fork.id !== repository.id))) this.fail(t('Fork 绑定在提交过程中发生变化，请重新预览。'));
    return this.withSyncedFork(prepared, repository, async () => {
      const path = this.repositoryPath(repository);
      const existing = await this.adapter.optional<Reference>(`${path}/git/ref/heads/${segment(branch)}`);
      let sha: string;
      if (existing) {
        sha = existing.object.sha;
        await this.assertUnpublishedBase(prepared, repository, sha);
        await this.inspect(prepared, repository, branch, sha, this.desiredContent(prepared));
      } else {
        progress({ stage: 'committing', message: t('正在为 {{count}} 个代码文件创建一个完整提交…', { count: this.changedPaths(prepared).length }) });
        sha = await this.createCommit(prepared, repository, branch, prepared.baseSha);
        progress({ stage: 'branching', message: t('所有代码已就绪，正在原子发布客户端分支…') });
        await this.publish(prepared, repository, branch, sha);
      }
      progress({ stage: 'pull-request', message: t('正在创建本次提交的 Pull Request…') });
      await this.adapter.assertForkCurrent(repository, prepared.upstream, prepared.baseSha);
      const beforePull = await this.adapter.request<Reference>(`${path}/git/ref/heads/${segment(branch)}`);
      if (beforePull.object.sha !== sha) this.fail(t('创建 Pull Request 前分支发生变化，已停止操作，请刷新后重试。'));
      let pull: Pull;
      try {
        pull = await this.adapter.request<Pull>(`${UPSTREAM_PATH}/pulls`, 'POST', {
          title: prepared.title, body: this.body(prepared, branch), head: `${prepared.login}:${branch}`, base: prepared.upstream.default_branch,
        });
      } catch (error) {
        const recovered = await this.branchPull(prepared, branch);
        if (!recovered) throw error;
        pull = recovered;
      }
      this.assertPull(pull, prepared, repository, branch, sha);
      const complete = await this.recoverNew(pull, prepared, repository, false, sha);
      progress({ stage: 'complete', message: t('提交完成，有变更的文件已进入新建的 Pull Request。') });
      return complete;
    });
  }
}
