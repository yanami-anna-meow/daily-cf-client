import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { build, configureBuildCommand, createYargs } = require('electron-builder/out/builder');
const { Arch, Platform, WinPackager, MacPackager, LinuxPackager } = require('electron-builder');
const { loadEnv } = require('app-builder-lib/out/util/config/load');

// Keep Electron's architecture identifiers and package metadata unchanged. Only
// substitute the filename macro, before builder generates installer/update files.
export function createPlatformPackager(info, platform) {
  const BasePackager = new Map([
    [Platform.WINDOWS, WinPackager], [Platform.MAC, MacPackager], [Platform.LINUX, LinuxPackager],
  ]).get(platform);
  if (!BasePackager) throw new Error(`Unsupported platform: ${platform}`);
  return new class extends BasePackager {
    computeArtifactName(pattern, extension, arch) {
      const name = arch === Arch.x64 ? 'x86_64' : arch === Arch.arm64 ? 'arm64' : null;
      return super.computeArtifactName(name ? pattern.replaceAll('${arch}', name) : pattern, extension, arch);
    }
  }(info);
}

async function main() {
  // Reuse builder's CLI parsing, including multiple targets and architectures.
  const options = configureBuildCommand(createYargs()).help().strict().parse(process.argv.slice(2));
  if (options.help || options.version) return;
  await loadEnv(join(process.cwd(), 'electron-builder.env'));
  await build({ ...options, platformPackagerFactory: createPlatformPackager });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
