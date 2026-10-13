import { t } from '../shared/i18n';

/** Own the PAT validation lock by login generation. A cancelled request can
 * finish later, but must never release a newer request's lock. */
export class LoginAttemptLock {
  private generation?: number;

  get active(): boolean { return this.generation !== undefined; }

  acquire(generation: number): void {
    if (this.active) throw new Error(t('正在验证登录，请稍候。'));
    this.generation = generation;
  }

  release(generation: number): void {
    if (this.generation === generation) this.generation = undefined;
  }

  clear(): void { this.generation = undefined; }
}
