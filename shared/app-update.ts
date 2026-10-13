export interface AppUpdateTarget {
  platform: 'windows' | 'macos' | 'linux' | 'unknown';
  arch: 'x86_64' | 'arm64' | 'unknown';
  packageKind: 'nsis' | 'portable' | 'dmg' | 'appimage' | 'deb' | 'unknown';
  mode: 'installer' | 'replace-file' | 'unsupported';
  development: boolean;
}

export interface AppUpdateRelease {
  version: string;
  url: string;
  publishedAt: string;
  notes: string;
  asset?: { name: string; size: number };
}

export interface AppUpdateState {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
  currentVersion: string;
  target: AppUpdateTarget;
  release?: AppUpdateRelease;
  progress?: { downloaded: number; total: number };
  checkedAt?: string;
  error?: string;
}
