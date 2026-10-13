import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPlatformPackager } from '../scripts/package.mjs';
import { artifactNames, binaryArchitecture, validateAssetSet } from '../scripts/verify-release.mjs';

const require = createRequire(import.meta.url);
const { Arch, Packager, Platform } = require('electron-builder');
const { toLinuxArchString } = require('builder-util');

function executable(platform, arch) {
  const bytes = Buffer.alloc(512);
  if (platform === 'windows') {
    bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.writeUInt32LE(0x4550, 128);
    bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 132);
  } else if (platform === 'linux') {
    bytes.write('\x7fELF'); bytes[4] = 2; bytes[5] = 1;
    bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === 'x64' ? 0x1000007 : 0x100000c, 4);
  }
  return bytes;
}

const targets = ['windows', 'macos', 'linux'].flatMap(platform => ['x64', 'arm64'].map(arch => ({ platform, arch })));

describe('release executable architecture', () => {
  it.each(targets)('reads $platform $arch from the executable, independent of its filename', ({ platform, arch }) => {
    expect(binaryArchitecture(executable(platform, arch), platform)).toBe(arch);
  });

  it('rejects broken headers instead of treating them as an architecture', () => {
    for (const platform of ['windows', 'macos', 'linux']) {
      expect(() => binaryArchitecture(Buffer.alloc(512), platform)).toThrow();
      expect(() => binaryArchitecture(Buffer.alloc(16), platform)).toThrow();
    }
    const badPe = executable('windows', 'x64'); badPe.writeUInt32LE(510, 0x3c);
    expect(() => binaryArchitecture(badPe, 'windows')).toThrow('outside');
    const elf32 = executable('linux', 'arm64'); elf32[4] = 1;
    expect(() => binaryArchitecture(elf32, 'linux')).toThrow('64-bit');
  });

  it('does not identify unsupported CPUs as x64 or arm64', () => {
    const pe = executable('windows', 'x64'); pe.writeUInt16LE(0x14c, 132);
    const elf = executable('linux', 'x64'); elf.writeUInt16LE(40, 18);
    const mach = executable('macos', 'x64'); mach.writeUInt32LE(7, 4);
    expect(binaryArchitecture(pe, 'windows')).toBe('unsupported');
    expect(binaryArchitecture(elf, 'linux')).toBe('unsupported');
    expect(binaryArchitecture(mach, 'macos')).toBe('unsupported');
  });
});

describe('complete release asset set', () => {
  const version = '0.3.24';
  const files = targets.flatMap(({ platform, arch }) => artifactNames(version, platform, arch));

  it('requires twelve unique filenames and allows any upload order', () => {
    expect(new Set(files).size).toBe(12);
    expect(validateAssetSet(version, [...files].reverse())).toEqual([...files].sort());
    expect(files).toContain('Daily-CF-0.3.24-windows-arm64-portable.exe');
    expect(files).toContain('Daily-CF-0.3.24-macos-arm64.dmg');
    expect(files).toContain('Daily-CF-0.3.24-linux-arm64.AppImage');
    expect(files).toContain('Daily-CF-0.3.24-linux-x86_64.AppImage');
    expect(files).toContain('Daily-CF-0.3.24-linux-x86_64.deb');
    expect(files).toContain('Daily-CF-0.3.24-windows-x86_64-nsis.exe');
    expect(files).toContain('Daily-CF-0.3.24-windows-x86_64-portable.exe');
    expect(files).toContain('Daily-CF-0.3.24-macos-x86_64.dmg');
    expect(files).toContain('Daily-CF-0.3.24-macos-x86_64.zip');
  });

  it('rejects missing, duplicate, previous-version, and unexpected files', () => {
    expect(() => validateAssetSet(version, files.slice(1))).toThrow();
    expect(() => validateAssetSet(version, [...files.slice(1), files[1]])).toThrow();
    expect(() => validateAssetSet(version, files.map(file => file.replace('0.3.24', '0.3.23')))).toThrow();
    expect(() => validateAssetSet(version, [...files, 'builder-debug.yml'])).toThrow();
  });

  it('rejects unsupported target names and versions containing paths', () => {
    expect(() => artifactNames(version, 'windows', 'ia32')).toThrow();
    expect(() => artifactNames(version, 'unknown', 'x64')).toThrow();
    expect(() => artifactNames('../0.3.24', 'linux', 'x64')).toThrow();
  });
});

describe('electron-builder artifact naming', () => {
  let info;
  beforeAll(async () => {
    info = new Packager({ publish: 'never' });
    await info.validateConfig();
  });

  it.each(targets)('expands the actual $platform $arch package patterns to the expected filenames', ({ platform, arch }) => {
    const targetPlatform = { windows: Platform.WINDOWS, macos: Platform.MAC, linux: Platform.LINUX }[platform];
    const packager = createPlatformPackager(info, targetPlatform);
    const packageTypes = platform === 'windows' ? [['nsis', 'exe'], ['portable', 'exe']]
      : platform === 'macos' ? [['dmg', 'dmg'], ['zip', 'zip']] : [['appImage', 'AppImage'], ['deb', 'deb']];
    const names = packageTypes.map(([target, extension]) => packager.expandArtifactNamePattern(info.config[target], extension, Arch[arch]));
    expect(names).toEqual(artifactNames(info.metadata.version, platform, arch));
  });

  it('keeps simultaneous architecture expansions independent and preserves Debian architecture identifiers', () => {
    const packager = createPlatformPackager(info, Platform.LINUX);
    const originalPattern = info.config.linux.artifactName;
    const names = [Arch.x64, Arch.arm64, Arch.x64].map(arch => packager.expandArtifactNamePattern({}, 'deb', arch));
    expect(names).toEqual(['x86_64', 'arm64', 'x86_64'].map(arch => `Daily-CF-${info.metadata.version}-linux-${arch}.deb`));
    expect(info.config.linux.artifactName).toBe(originalPattern);
    expect(toLinuxArchString(Arch.x64, 'deb')).toBe('amd64');
    expect(toLinuxArchString(Arch.arm64, 'deb')).toBe('arm64');
  });
});
