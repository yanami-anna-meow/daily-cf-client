import { posix, win32 } from 'node:path';
import type { AppUpdateTarget } from '../shared/app-update';

interface RuntimePackage {
  platform: string;
  arch: string;
  isPackaged: boolean;
  portableExecutable?: string;
  appImage?: string;
  packageType?: string;
}

function isWindowsAbsolutePath(value: string | undefined): boolean {
  if (!value?.trim() || !win32.isAbsolute(value)) return false;
  // A drive-relative or root-relative path does not identify a portable file.
  return /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

export function detectAppUpdateTarget(runtime: RuntimePackage): AppUpdateTarget {
  const platform = runtime.platform === 'win32' ? 'windows' : runtime.platform === 'darwin' ? 'macos'
    : runtime.platform === 'linux' ? 'linux' : 'unknown';
  // Keep the running application's architecture, including under emulation.
  const arch = runtime.arch === 'x64' ? 'x86_64' : runtime.arch === 'arm64' ? 'arm64' : 'unknown';
  const target: AppUpdateTarget = {
    platform, arch, packageKind: 'unknown', mode: 'unsupported', development: !runtime.isPackaged,
  };
  if (target.development || platform === 'unknown' || arch === 'unknown') return target;

  if (platform === 'windows') {
    const portable = isWindowsAbsolutePath(runtime.portableExecutable);
    return { ...target, packageKind: portable ? 'portable' : 'nsis', mode: portable ? 'replace-file' : 'installer' };
  }
  // Both the DMG and ZIP distributions contain the same .app bundle.
  if (platform === 'macos') return { ...target, packageKind: 'dmg', mode: 'installer' };

  // AppImage must precede package-type: DEB packaging can write that marker into
  // the shared unpacked resources used by other Linux targets.
  if (runtime.appImage?.trim() && posix.isAbsolute(runtime.appImage)) {
    return { ...target, packageKind: 'appimage', mode: 'replace-file' };
  }
  if (runtime.packageType?.trim() === 'deb') return { ...target, packageKind: 'deb', mode: 'installer' };
  return target;
}
