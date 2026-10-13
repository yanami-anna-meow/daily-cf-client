import { describe, expect, it } from 'vitest';
import { detectAppUpdateTarget } from '../electron/app-update-target';

describe('application update package detection', () => {
  const systems = [
    { platform: 'win32', expectedPlatform: 'windows', packageKind: 'nsis', packageType: undefined },
    { platform: 'darwin', expectedPlatform: 'macos', packageKind: 'dmg', packageType: undefined },
    { platform: 'linux', expectedPlatform: 'linux', packageKind: 'deb', packageType: 'deb' },
  ];
  const targets = systems.flatMap(system => ['x64', 'arm64'].map(arch => ({ ...system, arch })));

  it.each(targets)('selects the $platform $arch installer', ({ platform, expectedPlatform, arch, packageKind, packageType }) => {
    expect(detectAppUpdateTarget({ platform, arch, packageType, isPackaged: true })).toEqual({
      platform: expectedPlatform, arch: arch === 'x64' ? 'x86_64' : 'arm64', packageKind, mode: 'installer', development: false,
    });
  });

  it.each(['x64', 'arm64'])('keeps Windows portable %s as a file replacement', arch => {
    expect(detectAppUpdateTarget({ platform: 'win32', arch, isPackaged: true,
      portableExecutable: 'C:\\Users\\Someone\\Downloads\\Daily CF portable.exe' })).toMatchObject({
      packageKind: 'portable', mode: 'replace-file', arch: arch === 'x64' ? 'x86_64' : 'arm64',
    });
  });

  it.each(['\\\\server\\share\\Daily CF.exe', '\\\\?\\C:\\Daily CF.exe', 'D:/Downloads/Daily CF.exe'])(
    'recognizes an absolute Windows portable path: %s', portableExecutable => {
      expect(detectAppUpdateTarget({ platform: 'win32', arch: 'x64', isPackaged: true, portableExecutable }).packageKind).toBe('portable');
    },
  );

  it.each([undefined, '', '   ', 'portable.exe', 'C:portable.exe', '\\portable.exe', '/tmp/portable.exe'])(
    'does not treat an invalid portable marker as a portable build: %s', portableExecutable => {
      expect(detectAppUpdateTarget({ platform: 'win32', arch: 'x64', isPackaged: true, portableExecutable }).packageKind).toBe('nsis');
    },
  );

  it.each(['x64', 'arm64'])('gives the AppImage marker precedence over a shared DEB marker for %s', arch => {
    expect(detectAppUpdateTarget({ platform: 'linux', arch, isPackaged: true,
      appImage: '/home/someone/My Apps/Daily CF.AppImage', packageType: 'deb' })).toMatchObject({
      packageKind: 'appimage', mode: 'replace-file', arch: arch === 'x64' ? 'x86_64' : 'arm64',
    });
  });

  it('reads the DEB package marker with surrounding whitespace', () => {
    expect(detectAppUpdateTarget({ platform: 'linux', arch: 'arm64', isPackaged: true, packageType: 'deb\n' }).packageKind).toBe('deb');
  });

  it.each([undefined, '', '   ', 'app.AppImage', 'C:\\app.AppImage'])(
    'does not guess an installer from an unknown Linux package or invalid AppImage marker: %s', appImage => {
      expect(detectAppUpdateTarget({ platform: 'linux', arch: 'x64', isPackaged: true, appImage })).toMatchObject({
        packageKind: 'unknown', mode: 'unsupported', development: false,
      });
    },
  );

  it.each(['rpm', 'snap', 'flatpak', 'DEB'])('does not identify %s as a DEB package', packageType => {
    expect(detectAppUpdateTarget({ platform: 'linux', arch: 'x64', isPackaged: true, packageType }).mode).toBe('unsupported');
  });

  it.each(targets)('disables installation in the $platform $arch development app', ({ platform, arch, packageType }) => {
    expect(detectAppUpdateTarget({ platform, arch, packageType, isPackaged: false,
      portableExecutable: 'C:\\app.exe', appImage: '/tmp/app.AppImage' })).toMatchObject({
      packageKind: 'unknown', mode: 'unsupported', development: true,
    });
  });

  it.each(['ia32', 'arm', 'riscv64', 'x86_64', ''])('does not substitute a supported architecture for %s', arch => {
    for (const { platform, packageType } of systems) {
      expect(detectAppUpdateTarget({ platform, arch, packageType, isPackaged: true })).toMatchObject({
        arch: 'unknown', packageKind: 'unknown', mode: 'unsupported', development: false,
      });
    }
  });

  it.each(['freebsd', 'openbsd', 'windows', ''])('does not guess the operating system for %s', platform => {
    expect(detectAppUpdateTarget({ platform, arch: 'x64', isPackaged: true })).toEqual({
      platform: 'unknown', arch: 'x86_64', packageKind: 'unknown', mode: 'unsupported', development: false,
    });
  });

  it('ignores package markers from other platforms', () => {
    expect(detectAppUpdateTarget({ platform: 'darwin', arch: 'x64', isPackaged: true,
      portableExecutable: 'C:\\app.exe', appImage: '/tmp/app.AppImage', packageType: 'deb' }).packageKind).toBe('dmg');
    expect(detectAppUpdateTarget({ platform: 'linux', arch: 'x64', isPackaged: true,
      portableExecutable: 'C:\\app.exe' }).mode).toBe('unsupported');
  });
});
