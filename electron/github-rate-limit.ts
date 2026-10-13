import type { RateLimitInfo } from '../shared/rate-limit';

const FALLBACK_DELAY = 60_000;
const MAX_DATE = 8_640_000_000_000_000;

function requestScope(url: string): { scope: string; resource: string } {
  const parsed = new URL(url, 'https://api.github.com');
  return parsed.hostname === 'api.github.com'
    ? { scope: 'api', resource: parsed.pathname.startsWith('/search/') ? 'search' : 'core' }
    : { scope: parsed.hostname, resource: 'raw' };
}

function secondsHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name)?.trim();
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** In-memory scheduling only. Create one instance per credential context; no content is retained. */
export class GitHubRateLimitGate {
  private readonly now: () => number;
  private readonly primary = new Map<string, RateLimitInfo>();
  private readonly secondary = new Map<string, RateLimitInfo>();

  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  blocked(url: string): RateLimitInfo | undefined {
    const { scope, resource } = requestScope(url);
    const active: RateLimitInfo[] = [];
    for (const [map, key] of [[this.primary, `${scope}:${resource}`], [this.secondary, scope]] as const) {
      const info = map.get(key);
      if (!info) continue;
      if (info.retryAt <= this.now()) map.delete(key);
      else active.push(info);
    }
    const longest = active.sort((a, b) => b.retryAt - a.retryAt)[0];
    return longest ? { ...longest } : undefined;
  }

  /** Record exhausted successful responses too, but let that successful request finish. */
  observe(url: string, response: Response, detail: string, authenticated: boolean): RateLimitInfo | undefined {
    const { scope, resource: requestedResource } = requestScope(url);
    const rawResource = response.headers.get('x-ratelimit-resource');
    const resource = scope === 'api' && rawResource && /^[a-z][a-z0-9_]{0,79}$/.test(rawResource) ? rawResource : requestedResource;
    const exhausted = response.headers.get('x-ratelimit-remaining')?.trim() === '0';
    const secondaryMessage = /secondary rate|abuse|too many requests/i.test(detail);
    const rejected = response.status === 429 || (response.status === 403
      && (exhausted || response.headers.has('retry-after') || /rate.?limit|abuse|too many requests/i.test(detail)));
    if (!rejected && !(response.ok && exhausted && scope === 'api')) return undefined;
    const kind = scope === 'api' && (exhausted || (!secondaryMessage && /API rate limit exceeded/i.test(detail))) ? 'primary' : 'secondary';
    const now = this.now();
    const retrySeconds = secondsHeader(response.headers, 'retry-after');
    const resetSeconds = secondsHeader(response.headers, 'x-ratelimit-reset');
    const advertised = retrySeconds !== undefined ? now + retrySeconds * 1000
      : kind === 'primary' && resetSeconds !== undefined ? resetSeconds * 1000 : now + FALLBACK_DELAY;
    const retryAt = Number.isFinite(advertised) && advertised > now && advertised <= MAX_DATE ? advertised : now + FALLBACK_DELAY;
    const info: RateLimitInfo = { retryAt, resource, kind, authenticated };
    const map = kind === 'primary' ? this.primary : this.secondary;
    const key = kind === 'primary' ? `${scope}:${resource}` : scope;
    const previous = map.get(key);
    if (!previous || previous.retryAt < retryAt) map.set(key, info);
    // A late response from an already in-flight request cannot shorten a known cooldown.
    const recorded = map.get(key)!;
    return rejected ? { ...recorded } : undefined;
  }
}

/** Error pages can be arbitrary size. Inspect only a small prefix for secondary-limit messages. */
export async function rateLimitResponseDetail(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let detail = '';
  let bytes = 0;
  try {
    while (bytes < 16_384) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = value.subarray(0, 16_384 - bytes);
      bytes += piece.byteLength;
      detail += decoder.decode(piece, { stream: true });
    }
    return detail + decoder.decode();
  } finally { await reader.cancel(); }
}
