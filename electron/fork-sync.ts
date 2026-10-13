import { t } from '../shared/i18n';
import type { ForkSyncStatus } from '../shared/types';

export interface ForkSyncRepository {
  id?: number;
  full_name: string;
  default_branch: string;
  owner: { login: string };
}

/** Only authenticated main-process capabilities are supplied to this service. */
export interface ForkSyncAdapter {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  error(message: string, status?: number): Error;
}

interface Reference { ref?: string; object: { sha: string; type?: string } }
interface Comparison {
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  ahead_by: number;
  behind_by: number;
  base_commit: { sha: string };
  merge_base_commit: { sha: string };
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const encodeBranch = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');
const statusOf = (error: unknown): number | undefined => {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  return typeof status === 'number' && Number.isSafeInteger(status) && status >= 0 && status <= 599 ? status : undefined;
};
const errorStatus = (error: unknown): number => statusOf(error) ?? 409;

/** A fork is advanced only when the fixed upstream commit already contains all
 * commits on its default branch. No merge, reset, or force push is performed. */
export class ForkSyncService {
  constructor(private readonly adapter: ForkSyncAdapter) {}

  private fail(message: string, status = 409): never { throw this.adapter.error(message, status); }

  private sha(value: unknown): string {
    if (typeof value !== 'string' || !shaPattern.test(value)) this.fail(t('GitHub 返回的提交版本无效，已停止同步 Fork。'));
    return value.toLowerCase();
  }

  private repositoryPath(repository: ForkSyncRepository): string {
    if (!repository || typeof repository.full_name !== 'string' ||
      (repository.id !== undefined && (!Number.isSafeInteger(repository.id) || repository.id <= 0)) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name) ||
      repository.full_name.split('/').some(part => part === '.' || part === '..') ||
      !repository.owner || typeof repository.owner.login !== 'string' ||
      !same(repository.full_name.split('/')[0], repository.owner.login)) {
      this.fail(t('Fork 仓库信息不完整或不匹配，请重新选择个人 Fork。'));
    }
    const branch = repository.default_branch;
    if (typeof branch !== 'string' || !branch || branch === '@' || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
      branch.includes('..') || branch.includes('@{') || branch.endsWith('.') ||
      branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
      this.fail(t('Fork 默认分支信息无效，请刷新仓库设置后重试。'));
    }
    return `/repos/${repository.full_name.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async head(repository: ForkSyncRepository): Promise<string> {
    const value = await this.adapter.request<Reference>(`${this.repositoryPath(repository)}/git/ref/heads/${encodeBranch(repository.default_branch)}`);
    if (!value || (value.ref !== undefined && value.ref !== `refs/heads/${repository.default_branch}`) ||
      !value.object || (value.object.type !== undefined && value.object.type !== 'commit')) {
      this.fail(t('GitHub 返回的默认分支引用不匹配，已停止同步 Fork。'));
    }
    return this.sha(value.object.sha);
  }

  private async assertUpstream(upstream: ForkSyncRepository, baseSha: string): Promise<void> {
    if (await this.head(upstream) !== baseSha) {
      this.fail(t('上游默认分支已更新，请刷新预览后重试，以最新上游版本提交。'));
    }
  }

  private async comparison(fork: ForkSyncRepository, baseSha: string, headSha: string): Promise<Pick<ForkSyncStatus, 'state' | 'aheadBy' | 'behindBy'>> {
    const value = await this.adapter.request<Comparison>(`${this.repositoryPath(fork)}/compare/${baseSha}...${headSha}`);
    if (!value || !Number.isSafeInteger(value.ahead_by) || value.ahead_by < 0 ||
      !Number.isSafeInteger(value.behind_by) || value.behind_by < 0 ||
      !value.base_commit || this.sha(value.base_commit.sha) !== baseSha || !value.merge_base_commit) {
      this.fail(t('GitHub 返回的分支比较结果不完整，无法安全同步 Fork。'));
    }
    const mergeBase = this.sha(value.merge_base_commit.sha);
    const valid = value.status === 'identical'
      ? baseSha === headSha && mergeBase === baseSha && value.ahead_by === 0 && value.behind_by === 0
      : value.status === 'ahead'
        ? baseSha !== headSha && mergeBase === baseSha && value.ahead_by > 0 && value.behind_by === 0
        : value.status === 'behind'
          ? baseSha !== headSha && mergeBase === headSha && value.ahead_by === 0 && value.behind_by > 0
          : value.status === 'diverged'
            ? baseSha !== headSha && mergeBase !== baseSha && mergeBase !== headSha && value.ahead_by > 0 && value.behind_by > 0
            : false;
    if (!valid) this.fail(t('GitHub 返回的分支比较结果相互矛盾，无法安全同步 Fork。'));
    return { state: value.status === 'identical' ? 'synced' : value.status, aheadBy: value.ahead_by, behindBy: value.behind_by };
  }

  /** Read-only; the snapshot always refers to one immutable upstream commit. */
  async inspect(upstream: ForkSyncRepository, fork: ForkSyncRepository, baseSha: string): Promise<ForkSyncStatus> {
    baseSha = this.sha(baseSha);
    this.repositoryPath(upstream);
    this.repositoryPath(fork);
    await this.assertUpstream(upstream, baseSha);
    const forkSha = await this.head(fork);
    const comparison = await this.comparison(fork, baseSha, forkSha);
    if (await this.head(fork) !== forkSha) this.fail(t('个人 Fork 默认分支在检查期间已变化，请刷新预览后重试。'));
    await this.assertUpstream(upstream, baseSha);
    return { ...comparison, repository: fork.full_name, branch: fork.default_branch, upstreamSha: baseSha, forkSha };
  }

  /** Read-only guard immediately before writing solution objects or publishing
   * a PR ref. An ahead-only fork is valid and retains its own commits. */
  async assertCurrent(upstream: ForkSyncRepository, fork: ForkSyncRepository, baseSha: string): Promise<ForkSyncStatus> {
    const status = await this.inspect(upstream, fork, baseSha);
    if (status.state === 'behind') this.fail(t('个人 Fork 默认分支尚未包含最新上游提交，请刷新预览并同步后重试。'));
    if (status.state === 'diverged') this.fail(t('个人 Fork 默认分支与上游已分叉，请先在 GitHub 手动合并上游并解决冲突，再重新预览。'));
    return status;
  }

  /** Existing PR heads are inspected independently of the fork default branch.
   * Updating a PR branch automatically could change its arbitrary manual work. */
  async assertContainsBase(fork: ForkSyncRepository, baseSha: string, headSha: string): Promise<void> {
    baseSha = this.sha(baseSha);
    headSha = this.sha(headSha);
    const status = await this.comparison(fork, baseSha, headSha);
    if (status.state !== 'synced' && status.state !== 'ahead') {
      this.fail(t('所选 PR 的分支尚未包含最新上游提交，请先在 GitHub 更新该 PR 分支并解决冲突，再重新预览提交。'));
    }
  }

  /** Fast-forward a behind-only personal default branch. expectedForkSha is an
   * optional stricter check for callers holding an earlier inspected snapshot. */
  async synchronize(upstream: ForkSyncRepository, fork: ForkSyncRepository, baseSha: string, expectedForkSha?: string): Promise<ForkSyncStatus> {
    baseSha = this.sha(baseSha);
    const status = await this.inspect(upstream, fork, baseSha);
    if (expectedForkSha !== undefined && status.forkSha !== this.sha(expectedForkSha)) {
      this.fail(t('个人 Fork 默认分支已变化，请刷新预览后重试。'));
    }
    // Isolated smoke tests may explicitly bind the configured upstream owned by
    // the user. Its default branch remains strictly read-only.
    if (same(fork.full_name, upstream.full_name)) {
      if (fork.default_branch !== upstream.default_branch || status.state !== 'synced') {
        this.fail(t('不能通过 Fork 同步操作修改上游仓库的默认分支。'));
      }
      return status;
    }
    if (status.state === 'diverged') this.fail(t('个人 Fork 默认分支与上游已分叉，请先在 GitHub 手动合并上游并解决冲突，再重新预览。'));
    if (status.state !== 'behind') return status;

    const forkPath = this.repositoryPath(fork);
    const freshFork = await this.adapter.request<ForkSyncRepository>(forkPath);
    this.repositoryPath(freshFork);
    if (((freshFork.id !== undefined || fork.id !== undefined) && freshFork.id !== fork.id) ||
      !same(freshFork.full_name, fork.full_name) || !same(freshFork.owner.login, fork.owner.login) ||
      freshFork.default_branch !== fork.default_branch) {
      this.fail(t('个人 Fork 的仓库或默认分支已变化，请重新选择 Fork 并预览。'));
    }
    await this.assertUpstream(upstream, baseSha);
    if (await this.head(fork) !== status.forkSha) this.fail(t('个人 Fork 默认分支在同步前已变化，请刷新预览后重试。'));
    await this.assertUpstream(upstream, baseSha);

    let published = false;
    try {
      try {
        const reference = await this.adapter.request<Reference>(`${forkPath}/git/refs/heads/${encodeBranch(fork.default_branch)}`, 'PATCH', { sha: baseSha, force: false });
        if (!reference?.object || this.sha(reference.object.sha) !== baseSha ||
          (reference.ref !== undefined && reference.ref !== `refs/heads/${fork.default_branch}`) ||
          (reference.object.type !== undefined && reference.object.type !== 'commit')) {
          this.fail(t('无法确认 Fork 同步响应，正在核实远端分支。'));
        }
        published = true;
      } catch (error) {
        // A lost PATCH response is recoverable only by reading the exact target
        // SHA. Never issue another PATCH or infer success from a different head.
        let currentSha: string;
        try { currentSha = await this.head(fork); }
        catch (recoveryError) {
          const originalStatus = statusOf(error);
          const readStatus = statusOf(recoveryError);
          // Authentication failure must still reach the main-process logout
          // handler even if a subsequent recovery request fails differently.
          const status = originalStatus === 401 || readStatus === 401 ? 401
            : originalStatus !== undefined && originalStatus >= 400 ? originalStatus : readStatus ?? originalStatus ?? 409;
          const originalDetail = error instanceof Error ? `${error.message} ` : '';
          const recoveryDetail = recoveryError instanceof Error ? recoveryError.message : t('恢复读取失败。');
          this.fail(t('{{original}}无法读取 Fork 默认分支以确认同步结果：{{detail}}', { original: originalDetail, detail: recoveryDetail }), status);
        }
        if (currentSha !== baseSha) {
          const detail = error instanceof Error ? `${error.message} ` : '';
          this.fail(t('{{detail}}Fork 同步未能确认成功，远端分支可能已变化；请刷新预览后重试。', { detail }), errorStatus(error));
        }
        published = true;
      }
      return await this.assertCurrent(upstream, fork, baseSha);
    } catch (error) {
      const detail = error instanceof Error ? error.message : t('无法确认远端分支状态。');
      this.fail(t('{{detail}} {{state}}，尚未提交本次代码，请刷新预览后重试。', { detail, state: published ? t('Fork 默认分支已安全快进') : t('Fork 默认分支可能已发生变化') }), errorStatus(error));
    }
  }
}
