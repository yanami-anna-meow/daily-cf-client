import { describe, expect, it } from 'vitest';
import {
  AppUpdateError, MAX_CHECKSUM_BYTES, MAX_INSTALLER_BYTES, appUpdateAssetName,
  checksumForAsset, compareAppVersions, resolveAppUpdate,
} from '../electron/app-update-release';
import type { AppUpdateAsset } from '../electron/app-update-release';
import type { AppUpdateTarget } from '../shared/app-update';

const repo = 'https://github.com/yanami-anna-meow/daily-cf-client';
const digest = '0123456789abcdef'.repeat(4);
const version = '0.3.25';
const windows: AppUpdateTarget = {
  platform: 'windows', arch: 'x86_64', packageKind: 'nsis', mode: 'installer', development: false,
};
const filename = 'Daily-CF-0.3.25-windows-x86_64-nsis.exe';

function releaseAsset(name = filename, tag = `v${version}`) {
  return {
    id: 23, name, state: 'uploaded', size: 500, digest: `sha256:${digest}`,
    browser_download_url: `${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  };
}

function release() {
  return {
    tag_name: `v${version}`, draft: false, prerelease: false,
    html_url: `${repo}/releases/tag/v${version}`, published_at: '2026-10-14T08:00:00Z',
    body: 'Release notes\n\n发布说明',
    assets: [releaseAsset(), { ...releaseAsset('SHA256SUMS.txt'), id: 24 }],
  };
}

function invalidRelease(value: unknown) {
  expect(() => resolveAppUpdate(value, '0.3.24', windows)).toThrow(AppUpdateError);
  try { resolveAppUpdate(value, '0.3.24', windows); }
  catch (error) { expect(error).toHaveProperty('code', 'invalid_release'); }
}

describe('app update SemVer precedence', () => {
  it.each([
    ['0.3.9', '0.3.24'], ['0.3.99', '0.4.0'], ['0.99.99', '1.0.0'],
    ['1.0.0-alpha', '1.0.0-alpha.1'], ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
    ['1.0.0-alpha.beta', '1.0.0-beta'], ['1.0.0-beta', '1.0.0-beta.2'],
    ['1.0.0-beta.2', '1.0.0-beta.11'], ['1.0.0-beta.11', '1.0.0-rc.1'],
    ['1.0.0-rc.1', '1.0.0'], ['1.0.0-Z', '1.0.0-a'],
    ['9007199254740992.0.0', '9007199254740993.0.0'],
    ['1.9007199254740992.0', '1.9007199254740993.0'],
    ['1.0.9007199254740992', '1.0.9007199254740993'],
    ['1.0.0-9007199254740992', '1.0.0-9007199254740993'],
  ])('orders %s before %s without truncating numbers', (older, newer) => {
    expect(compareAppVersions(older, newer)).toBe(-1);
    expect(compareAppVersions(newer, older)).toBe(1);
  });

  it('ignores build metadata in precedence, including prerelease metadata', () => {
    expect(compareAppVersions('1.2.3+build.001', '1.2.3+other')).toBe(0);
    expect(compareAppVersions('1.2.3-beta.1+old', '1.2.3-beta.1+new')).toBe(0);
  });

  it.each([
    '', 'v1.2.3', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03',
    '1.2.3-01', '1.2.3-beta.01', '1.2.3-', '1.2.3+', '1.2.3-a..b',
    '1.2.3+build..1', ' 1.2.3', '1.2.3 ', '1.2.3\n', '1.2.3\r\n',
    '../1.2.3', '1.2.3_4', '1.2.3-中文', `${'9'.repeat(201)}.0.0`,
  ])('rejects malformed version %j on either side', bad => {
    expect(() => compareAppVersions(bad, '1.2.3')).toThrow(AppUpdateError);
    expect(() => compareAppVersions('1.2.3', bad)).toThrow(AppUpdateError);
  });
});

describe('app update package selection', () => {
  const kinds = [
    { platform: 'windows', packageKind: 'nsis', suffix: '-nsis.exe' },
    { platform: 'windows', packageKind: 'portable', suffix: '-portable.exe' },
    { platform: 'macos', packageKind: 'dmg', suffix: '.dmg' },
    { platform: 'linux', packageKind: 'appimage', suffix: '.AppImage' },
    { platform: 'linux', packageKind: 'deb', suffix: '.deb' },
  ] as const;
  const targets = kinds.flatMap(kind => (['x86_64', 'arm64'] as const).map(arch => ({ ...kind, arch })));

  it.each(targets)('selects $platform $arch $packageKind exactly', ({ suffix, ...kind }) => {
    const target = { ...windows, ...kind };
    const name = `Daily-CF-${version}-${kind.platform}-${kind.arch}${suffix}`;
    expect(appUpdateAssetName(version, target)).toBe(name);
    const data = release();
    data.assets = [releaseAsset(name), releaseAsset('SHA256SUMS.txt')];
    expect(resolveAppUpdate(data, '0.3.24', target)?.asset?.name).toBe(name);
  });

  it.each([
    { development: true }, { mode: 'unsupported' }, { arch: 'unknown' },
    { platform: 'unknown' }, { packageKind: 'unknown' },
    { platform: 'linux', packageKind: 'portable' }, { platform: 'macos', packageKind: 'nsis' },
  ] as Partial<AppUpdateTarget>[])('offers only the release page for unsupported target %j', changes => {
    const target = { ...windows, ...changes };
    expect(appUpdateAssetName(version, target)).toBeUndefined();
    const result = resolveAppUpdate(release(), '0.3.24', target);
    expect(result?.release.version).toBe(version);
    expect(result?.asset).toBeUndefined();
    expect(result?.release.asset).toBeUndefined();
  });

  it.each([
    'Daily-CF-0.3.25-windows-arm64-nsis.exe',
    'Daily-CF-0.3.25-windows-x86_64-portable.exe',
    'Daily-CF-0.3.25-linux-x86_64.deb',
    'Daily-CF-0.3.24-windows-x86_64-nsis.exe',
    'Daily-CF-0.3.25-windows-x64-nsis.exe',
  ])('never substitutes a different package when only %s exists', name => {
    const data = release(); data.assets = [releaseAsset(name)];
    expect(resolveAppUpdate(data, '0.3.24', windows)?.asset).toBeUndefined();
  });
});

describe('app update release metadata boundary', () => {
  it('keeps release notes and verifies both selected file URLs and digests', () => {
    const result = resolveAppUpdate(release(), '0.3.24', windows)!;
    expect(result.release).toEqual({
      version, url: `${repo}/releases/tag/v${version}`, publishedAt: '2026-10-14T08:00:00Z',
      notes: 'Release notes\n\n发布说明', asset: { name: filename, size: 500 },
    });
    expect(result.asset).toEqual({ id: 23, name: filename, size: 500, digest,
      url: `${repo}/releases/download/v${version}/${filename}` });
    expect(result.checksum?.name).toBe('SHA256SUMS.txt');
  });

  it('allows absent API digests only for later checksum verification, and reports absent checksum separately', () => {
    const data = release();
    Object.assign(data.assets[0], { digest: null });
    expect(resolveAppUpdate(data, '0.3.24', windows)?.asset?.digest).toBeUndefined();
    data.assets = [data.assets[0]];
    expect(resolveAppUpdate(data, '0.3.24', windows)?.checksum).toBeUndefined();
  });

  it('normalizes uppercase SHA-256 and handles null release notes', () => {
    const data = { ...release(), body: null };
    data.assets[0].digest = `SHA256:${digest.toUpperCase()}`;
    const result = resolveAppUpdate(data, '0.3.24', windows)!;
    expect(result.asset?.digest).toBe(digest);
    expect(result.release.notes).toBe('');
  });

  it('accepts a stable release following the currently installed prerelease', () => {
    expect(resolveAppUpdate(release(), '0.3.25-rc.2', windows)?.release.version).toBe(version);
  });

  it.each(['0.3.25', '0.3.25+local', '0.3.26', '1.0.0'])('does not downgrade current version %s', current => {
    expect(resolveAppUpdate(release(), current, windows)).toBeNull();
  });

  it.each([{ draft: true }, { prerelease: true }, { tag_name: 'v0.4.0-beta.1' }])('ignores unstable releases %j', changes => {
    expect(resolveAppUpdate({ ...release(), ...changes }, '0.3.24', windows)).toBeNull();
  });

  it('accepts literal or escaped plus signs in build metadata but treats their precedence equally', () => {
    const tag = 'v0.3.25+build.1';
    const name = 'Daily-CF-0.3.25+build.1-windows-x86_64-nsis.exe';
    const data = { ...release(), tag_name: tag, html_url: `${repo}/releases/tag/${tag}`, assets: [releaseAsset(name, tag)] };
    expect(resolveAppUpdate(data, '0.3.24', windows)?.asset?.name).toBe(name);
    expect(resolveAppUpdate(data, '0.3.25+build.2', windows)).toBeNull();
  });

  it.each([
    null, [], 'release', { draft: 'false' }, { prerelease: 0 }, { tag_name: 25 },
    { tag_name: '../0.3.25' }, { body: 1 }, { body: 'a'.repeat(256 * 1024 + 1) },
    { published_at: 'not-a-date' }, { published_at: null }, { assets: null },
    { assets: Array.from({ length: 1001 }, (_, id) => ({ name: String(id) })) },
    { assets: [null] }, { assets: [{ name: '' }] }, { assets: [releaseAsset(), releaseAsset()] },
  ])('rejects malformed metadata case %#', changes => {
    invalidRelease(changes && !Array.isArray(changes) && typeof changes === 'object' ? { ...release(), ...changes } : changes);
  });

  it('rejects metadata missing required fields', () => {
    invalidRelease({});
    invalidRelease({ draft: false, prerelease: false });
  });

  it.each([
    { id: 0 }, { id: -1 }, { id: 1.2 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: '23' },
    { size: 0 }, { size: -1 }, { size: 1.2 }, { size: '500' }, { size: MAX_INSTALLER_BYTES + 1 },
    { state: 'new' }, { state: null }, { digest: 'sha256:bad' }, { digest: 'md5:' + digest },
    { digest: 'sha256:' + digest + '\n' },
  ])('rejects invalid selected asset metadata %j', changes => {
    const data = release(); Object.assign(data.assets[0], changes); invalidRelease(data);
  });

  it('enforces a separate checksum size limit and validates its URL', () => {
    const data = release(); data.assets[1].size = MAX_CHECKSUM_BYTES + 1; invalidRelease(data);
    data.assets[1].size = 500; data.assets[1].browser_download_url = 'https://example.com/SHA256SUMS.txt'; invalidRelease(data);
  });

  const badUrls = [
    (url: string) => url.replace('https:', 'http:'),
    (url: string) => url.replace('github.com', 'github.com.evil.test'),
    (url: string) => url.replace('github.com', 'github.com@evil.test'),
    (url: string) => url.replace('github.com', 'user@github.com'),
    (url: string) => url.replace('github.com', 'github.com:443'),
    (url: string) => url.replace('daily-cf-client', 'Daily_CF_Problems'),
    (url: string) => url.replace('yanami-anna-meow', 'other-owner'),
    (url: string) => url.replace('/v0.3.25', '/v0.3.24'),
    (url: string) => url.replace('/releases/', '/other/../releases/'),
    (url: string) => url.replace('/releases/', '/other/%2e%2e/releases/'),
    (url: string) => url + '?download=1', (url: string) => url + '#file',
    (url: string) => ' ' + url, (url: string) => url + '\n',
  ];
  it.each(badUrls)('rejects misleading release and download URLs case %#', change => {
    const page = release(); page.html_url = change(page.html_url); invalidRelease(page);
    const file = release(); file.assets[0].browser_download_url = change(file.assets[0].browser_download_url); invalidRelease(file);
  });
});

describe('app update checksum manifest', () => {
  const asset: AppUpdateAsset = { id: 23, name: filename, size: 500, url: `${repo}/releases/download/v${version}/${filename}`, digest };

  it.each(['  ', ' *'])('accepts standard sha256sum separator %j, CRLF, and uppercase hashes', separator => {
    expect(checksumForAsset(`\r\n${digest.toUpperCase()}${separator}${filename}\r\n${'a'.repeat(64)}  other.zip\r\n`, asset)).toBe(digest);
  });

  it('uses the published manifest when GitHub did not provide a digest', () => {
    expect(checksumForAsset(`${digest}  ${filename}\n`, { ...asset, digest: undefined })).toBe(digest);
  });

  it.each([
    '', `${digest}  wrong.exe\n`, `${'a'.repeat(64)}  ${filename}\n`,
    `${digest}  ${filename}\n${digest}  ${filename}\n`,
    `${digest}  ${filename}\n${digest}  other.exe\n${digest}  other.exe\n`,
    `bad  ${filename}\n`, `${digest} ${filename}\n`, `${digest}\t${filename}\n`,
    `${digest}  ${filename} \n`, `${digest}  ./${filename}\n`,
    `${digest}  ${filename}\nmalformed unrelated entry\n`,
  ])('rejects missing, mismatched, ambiguous, or malformed checksum case %#', manifest => {
    expect(() => checksumForAsset(manifest, asset)).toThrow(AppUpdateError);
    try { checksumForAsset(manifest, asset); }
    catch (error) { expect(error).toHaveProperty('code', 'invalid_checksum'); }
  });
});
