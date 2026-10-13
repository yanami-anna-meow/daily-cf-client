import { t } from '../shared/i18n';

export type WindowTransition = 'quit' | 'close' | 'reload';

/** Remembers the native operation while an asynchronous renderer confirmation
 * cancels beforeunload. In particular, a cancelled quit must not become a close. */
export class WindowTransitionState {
  private quitting = false;
  private pending?: WindowTransition;

  requestQuit(): void { this.quitting = true; }

  requestClose(): void {
    this.pending = this.quitting ? 'quit' : 'close';
  }

  preventUnload(): void {
    // Reloads have no BrowserWindow close event. Existing close/quit intent is
    // more specific and must survive the later will-prevent-unload event.
    this.pending ??= 'reload';
  }

  clear(): void {
    this.pending = undefined;
    this.quitting = false;
  }

  resolve(proceed: unknown): WindowTransition | undefined {
    if (typeof proceed !== 'boolean') throw new Error(t('窗口操作确认必须为布尔值。'));
    if (!proceed) { this.clear(); return undefined; }
    const transition = this.pending;
    if (!transition) throw new Error(t('没有待确认的窗口操作，请重新尝试关闭或刷新。'));
    // Consume before replaying. Repeated confirmation cannot replay twice, and
    // cancelling one application quit cannot affect a later ordinary close.
    this.clear();
    return transition;
  }
}
