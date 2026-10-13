import type { AppUpdateRelease, AppUpdateTarget } from '../shared/app-update';
import { t } from '../shared/i18n';
import { CLIENT_REPOSITORY } from '../shared/metadata';

export const MAX_RELEASE_BYTES = 2 * 1024 * 1024;
export const MAX_CHECKSUM_BYTES = 256 * 1024;
export const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${CLIENT_REPOSITORY.owner}/${CLIENT_REPOSITORY.repo}/releases/latest`;

export class AppUpdateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AppUpdateError'; }
}

export interface AppUpdateAsset {
  id: number;
  name: string;
  size: number;
  url: string;
  digest?: string;
}
export interface ResolvedAppUpdate {
  release: AppUpdateRelease;
  asset?: AppUpdateAsset;
  checksum?: AppUpdateAsset;
}

function invalid(): never {
  throw new AppUpdateError('invalid_release', t('发布信息不完整或格式不正确，请到发布页面查看。'));
}

interface Version { core: bigint[]; prerelease: string[]; }
function parseVersion(value: string): Version {
  if (typeof value !== 'string' || value.length > 200) invalid();
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[0] !== value || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) invalid();
  return { core: match.slice(1, 4).map(part => BigInt(part)), prerelease: match[4]?.split('.') ?? [] };
}

/** SemVer precedence, including a stable release following a current prerelease. */
export function compareAppVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index]; const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numericX = /^\d+$/.test(x); const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function appUpdateAssetName(version: string, target: AppUpdateTarget): string | undefined {
  parseVersion(version);
  if (target.development || target.mode === 'unsupported' || !['x86_64', 'arm64'].includes(target.arch)) return undefined;
  const prefix = `Daily-CF-${version}-${target.platform}-${target.arch}`;
  if (target.platform === 'windows' && ['nsis', 'portable'].includes(target.packageKind)) return `${prefix}-${target.packageKind}.exe`;
  if (target.platform === 'macos' && target.packageKind === 'dmg') return `${prefix}.dmg`;
  if (target.platform === 'linux' && target.packageKind === 'appimage') return `${prefix}.AppImage`;
  if (target.platform === 'linux' && target.packageKind === 'deb') return `${prefix}.deb`;
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

/** Accept only the exact repository/tag/file URL. No credentials, query, or fragment. */
function releaseUrl(value: unknown, section: 'tag' | 'download', tag: string, name?: string): string {
  if (typeof value !== 'string' || value.length > 2048) invalid();
  let url: URL;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) invalid();
  const expected = `/${CLIENT_REPOSITORY.owner}/${CLIENT_REPOSITORY.repo}/releases/${section}/${encodeURIComponent(tag)}${name ? `/${encodeURIComponent(name)}` : ''}`;
  // GitHub can represent a literal '+' in a version either directly or escaped.
  if (url.pathname.replaceAll('+', '%2B') !== expected.replaceAll('+', '%2B')) invalid();
  // URL parsing normalizes dot segments; do not accept a misleading original URL.
  if (value !== url.href) invalid();
  return `${url.origin}${expected}`;
}

function parseAsset(value: unknown, tag: string, expectedName: string, maximum: number): AppUpdateAsset {
  const asset = record(value);
  if (asset.name !== expectedName || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.id) || Number(asset.id) <= 0
      || !Number.isSafeInteger(asset.size) || Number(asset.size) <= 0 || Number(asset.size) > maximum) invalid();
  let digest: string | undefined;
  if (asset.digest !== undefined && asset.digest !== null) {
    if (typeof asset.digest !== 'string' || asset.digest.length !== 71 || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) invalid();
    digest = asset.digest.slice(7).toLowerCase();
  }
  return { id: Number(asset.id), name: expectedName, size: Number(asset.size), url: releaseUrl(asset.browser_download_url, 'download', tag, expectedName), digest };
}

export function resolveAppUpdate(value: unknown, currentVersion: string, target: AppUpdateTarget): ResolvedAppUpdate | null {
  parseVersion(currentVersion);
  const data = record(value);
  if (typeof data.draft !== 'boolean' || typeof data.prerelease !== 'boolean') invalid();
  if (data.draft || data.prerelease) return null;
  if (typeof data.tag_name !== 'string') invalid();
  const tag = data.tag_name;
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (parseVersion(version).prerelease.length || compareAppVersions(version, currentVersion) <= 0) return null;
  if (typeof data.published_at !== 'string' || data.published_at.length > 64 || !Number.isFinite(Date.parse(data.published_at))
      || (data.body !== null && typeof data.body !== 'string') || (typeof data.body === 'string' && data.body.length > 256 * 1024)
      || !Array.isArray(data.assets) || data.assets.length > 1000) invalid();
  const release: AppUpdateRelease = {
    version, url: releaseUrl(data.html_url, 'tag', tag), publishedAt: data.published_at, notes: data.body ?? '',
  };
  const name = appUpdateAssetName(version, target);
  const assetNames = new Set<string>();
  for (const item of data.assets) {
    const entry = record(item);
    if (typeof entry.name !== 'string' || !entry.name || assetNames.has(entry.name)) invalid();
    assetNames.add(entry.name);
  }
  if (!name) return { release };
  const rawAsset = data.assets.find(item => record(item).name === name);
  if (!rawAsset) return { release };
  const asset = parseAsset(rawAsset, tag, name, MAX_INSTALLER_BYTES);
  release.asset = { name: asset.name, size: asset.size };
  const rawChecksum = data.assets.find(item => record(item).name === 'SHA256SUMS.txt');
  const checksum = rawChecksum ? parseAsset(rawChecksum, tag, 'SHA256SUMS.txt', MAX_CHECKSUM_BYTES) : undefined;
  return { release, asset, checksum };
}

export function checksumForAsset(text: string, asset: AppUpdateAsset): string {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f\d]{64}) [ *]([^\r\n]+)$/i.exec(line);
    if (!match || seen.has(match[2])) throw new AppUpdateError('invalid_checksum', t('校验清单格式不正确，请到发布页面重新下载。'));
    seen.add(match[2]);
    if (match[2] === asset.name) matches.push(match[1].toLowerCase());
  }
  if (matches.length !== 1 || (asset.digest && matches[0] !== asset.digest)) {
    throw new AppUpdateError('invalid_checksum', t('安装包的校验信息不一致，已停止下载。'));
  }
  return matches[0];
}
