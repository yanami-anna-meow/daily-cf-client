import type { DeviceLogin } from '../shared/types';
import { t } from '../shared/i18n';

const DEVICE_ENDPOINT = 'https://github.com/login/device/code';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const VERIFICATION_URI = 'https://github.com/login/device';
const expiredMessage = () => t('GitHub 验证码已过期，请重新登录。');

export interface GitHubAuthOptions {
  /** Validate the account and persist its credential in the main process only.
   * Check signal.aborted after asynchronous work, before changing login state. */
  onToken: (token: string, signal: AbortSignal) => Promise<void>;
  onError: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  requestTimeoutMs?: number;
}

interface LoginSession {
  controller: AbortController;
}

type JsonObject = Record<string, unknown>;

function cancelled(): Error {
  const error = new Error(t('GitHub 登录已取消。'));
  error.name = 'AbortError';
  return error;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= maximum;
}

function oauthError(error: unknown): string {
  switch (error) {
    case 'expired_token':
    case 'token_expired': return expiredMessage();
    case 'access_denied': return t('你已取消 GitHub 授权；如需提交题解，请重新登录。');
    case 'device_flow_disabled': return t('此 GitHub OAuth App 尚未启用 Device Flow，请在应用设置中启用后重试。');
    case 'incorrect_client_credentials':
    case 'invalid_client': return t('GitHub Client ID 无效，请检查客户端设置中的 OAuth App Client ID。');
    case 'incorrect_device_code': return t('GitHub 验证码无效，请重新登录。');
    case 'unsupported_grant_type': return t('GitHub 不支持本次登录请求，请更新客户端后重试。');
    default: return t('GitHub 未能完成授权，请重新登录。');
  }
}

/** GitHub Device Flow. Only safe display data crosses the public interface;
 * the device secret and access token never become renderer-visible results. */
export class GitHubAuth {
  private readonly options: GitHubAuthOptions;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly wait: NonNullable<GitHubAuthOptions['delay']>;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private session?: LoginSession;

  constructor(options: GitHubAuthOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.wait = options.delay ?? delay;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    if (!positiveInteger(this.requestTimeoutMs, 120_000)) {
      throw new Error(t('GitHub 请求超时时间必须为 1 至 120000 毫秒。'));
    }
  }

  /** Returns as soon as the device code is ready; polling continues privately. */
  async begin(clientId: string): Promise<DeviceLogin> {
    this.cancel();
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(clientId.trim())) {
      throw new Error(t('请先在设置中填写有效的 GitHub OAuth App Client ID。'));
    }
    clientId = clientId.trim();
    const session: LoginSession = { controller: new AbortController() };
    this.session = session;
    const requestedAt = this.now();

    try {
      const body = await this.post(DEVICE_ENDPOINT, { client_id: clientId, scope: 'public_repo' }, session);
      this.assertCurrent(session);
      if (body.error !== undefined) throw new Error(oauthError(body.error));
      const interval = body.interval === undefined ? 5 : body.interval;
      if (
        typeof body.device_code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(body.device_code) ||
        typeof body.user_code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(body.user_code) ||
        body.verification_uri !== VERIFICATION_URI ||
        !positiveInteger(body.expires_in, 86_400) || !positiveInteger(interval, 300)
      ) {
        throw new Error(t('GitHub 返回了无效的登录信息，请重试。'));
      }
      // Counting from the start of the request conservatively avoids using an
      // expired code when receiving the device response was unusually slow.
      const expiresAt = requestedAt + body.expires_in * 1000;
      if (this.now() >= expiresAt) throw new Error(expiredMessage());
      void this.poll(session, clientId, body.device_code, interval * 1000, expiresAt);
      return { userCode: body.user_code, verificationUri: VERIFICATION_URI, expiresAt };
    } catch (error) {
      if (this.session === session) {
        this.session = undefined;
        session.controller.abort();
      }
      throw error;
    }
  }

  /** Also aborts a pending device request, poll, or token callback. */
  cancel(): void {
    const session = this.session;
    this.session = undefined;
    session?.controller.abort();
  }

  private current(session: LoginSession): boolean {
    return this.session === session && !session.controller.signal.aborted;
  }

  private assertCurrent(session: LoginSession): void {
    if (!this.current(session)) throw cancelled();
  }

  private async poll(session: LoginSession, clientId: string, deviceCode: string, intervalMs: number, expiresAt: number): Promise<void> {
    try {
      while (this.current(session)) {
        const remaining = expiresAt - this.now();
        if (remaining <= 0) throw new Error(expiredMessage());
        // The first request must wait too. Sleep only until expiry when the
        // server's interval would otherwise run beyond the code's lifetime.
        await this.wait(Math.min(intervalMs, remaining), session.controller.signal);
        this.assertCurrent(session);
        if (this.now() >= expiresAt) throw new Error(expiredMessage());
        const body = await this.post(TOKEN_ENDPOINT, {
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }, session, Math.min(this.requestTimeoutMs, expiresAt - this.now()));
        this.assertCurrent(session);
        if (this.now() >= expiresAt) throw new Error(expiredMessage());

        if (body.error === 'authorization_pending') continue;
        if (body.error === 'slow_down') {
          intervalMs += 5000;
          if (positiveInteger(body.interval, 86_400)) intervalMs = Math.max(intervalMs, body.interval * 1000);
          continue;
        }
        if (body.error !== undefined) throw new Error(oauthError(body.error));
        if (typeof body.access_token !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(body.access_token) ||
            typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer' ||
            typeof body.scope !== 'string') {
          throw new Error(t('GitHub 返回了无效的授权凭据，请重新登录。'));
        }
        const scopes = body.scope.split(/[,\s]+/);
        if (!scopes.includes('public_repo') && !scopes.includes('repo')) {
          throw new Error(t('GitHub 授权缺少 public_repo 权限，无法提交到公开仓库，请重新登录并允许此权限。'));
        }
        this.assertCurrent(session);
        try {
          await this.options.onToken(body.access_token, session.controller.signal);
        } catch {
          throw new Error(t('GitHub 授权已完成，但账户验证或凭据保存失败，请重试登录。'));
        }
        return;
      }
    } catch (error) {
      if (this.current(session)) {
        const message = this.now() >= expiresAt ? expiredMessage()
          : error instanceof Error ? error.message : t('GitHub 登录失败，请重试。');
        // Consumer callbacks must not leave an unhandled background rejection.
        try { this.options.onError(message); } catch { /* UI notification failed. */ }
      }
    } finally {
      if (this.session === session) this.session = undefined;
    }
  }

  private async post(endpoint: typeof DEVICE_ENDPOINT | typeof TOKEN_ENDPOINT, fields: Record<string, string>, session: LoginSession, timeoutMs = this.requestTimeoutMs): Promise<JsonObject> {
    this.assertCurrent(session);
    const request = new AbortController();
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const abort = () => {
      request.abort();
      rejectStopped(cancelled());
    };
    session.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      request.abort();
      rejectStopped(new Error(t('连接 GitHub 超时，请检查网络后重新登录。')));
    }, timeoutMs);

    const responseBody = async (): Promise<JsonObject> => {
      let response: Response;
      try {
        response = await this.fetcher(endpoint, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
          signal: request.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
      } catch {
        // Network errors can include request details; never expose them.
        throw new Error(t('无法连接 GitHub，请检查网络或代理设置后重新登录。'));
      }
      let body: unknown;
      try {
        const text = await response.text();
        if (text.length > 65_536) throw new Error('Response too large');
        body = JSON.parse(text) as unknown;
      } catch {
        throw new Error(t('GitHub 登录服务返回了无法识别的响应，请稍后重试。'));
      }
      if (!response.ok && !(isObject(body) && typeof body.error === 'string')) {
        if (response.status === 429 || response.status === 403) throw new Error(t('GitHub 暂时限制了登录请求，请稍后重试。'));
        throw new Error(t('GitHub 登录服务暂时不可用（HTTP {{status}}），请稍后重试。', { status: response.status }));
      }
      if (!isObject(body)) throw new Error(t('GitHub 登录服务返回了无效的数据，请稍后重试。'));
      return body;
    };

    try {
      return await Promise.race([responseBody(), stopped]);
    } finally {
      clearTimeout(timer);
      session.controller.signal.removeEventListener('abort', abort);
    }
  }
}
