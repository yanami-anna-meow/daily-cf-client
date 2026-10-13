import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const platforms = ['windows', 'macos', 'linux'];
const architectures = ['x64', 'arm64'];
const repository = 'Yawn-Sean/Daily_CF_Problems';

export function artifactNames(version, platform, arch) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert(platforms.includes(platform) && architectures.includes(arch), 'Unsupported release target');
  const name = arch === 'x64' ? 'x86_64' : arch;
  if (platform === 'windows') return ['nsis.exe', 'portable.exe'].map(suffix => `Daily-CF-${version}-${platform}-${name}-${suffix}`);
  return (platform === 'macos' ? ['dmg', 'zip'] : ['AppImage', 'deb'])
    .map(extension => `Daily-CF-${version}-${platform}-${name}.${extension}`);
}

export function binaryArchitecture(bytes, platform) {
  assert(bytes.length >= 64, 'Truncated executable');
  let machine;
  if (platform === 'windows') {
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ', 'Expected a PE executable');
    const offset = bytes.readUInt32LE(0x3c);
    assert(offset + 6 <= bytes.length, 'PE header outside the executable');
    assert.equal(bytes.readUInt32LE(offset), 0x4550, 'Invalid PE signature');
    machine = bytes.readUInt16LE(offset + 4);
    return ({ 0x8664: 'x64', 0xaa64: 'arm64' })[machine] || 'unsupported';
  }
  if (platform === 'linux') {
    assert.equal(bytes.toString('hex', 0, 4), '7f454c46', 'Expected an ELF executable');
    assert.equal(bytes[4], 2, 'Expected a 64-bit ELF executable');
    assert.equal(bytes[5], 1, 'Expected little-endian ELF');
    machine = bytes.readUInt16LE(18);
    return ({ 62: 'x64', 183: 'arm64' })[machine] || 'unsupported';
  }
  assert.equal(platform, 'macos', 'Unsupported executable platform');
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'Expected a thin 64-bit Mach-O executable');
  machine = bytes.readUInt32LE(4);
  return ({ 0x1000007: 'x64', 0x100000c: 'arm64' })[machine] || 'unsupported';
}

function header(filename) {
  const descriptor = openSync(filename, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(statSync(filename).size, 65536));
    readSync(descriptor, bytes, 0, bytes.length, 0);
    return bytes;
  } finally { closeSync(descriptor); }
}

async function sha256(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

function packagedPaths(manifest, platform, arch) {
  const platformKey = platform === 'windows' ? 'win' : platform === 'macos' ? 'mac' : 'linux';
  const folder = join('release', `${platformKey}${arch === 'x64' ? '' : '-arm64'}${platform === 'macos' ? '' : '-unpacked'}`);
  const name = manifest.build.productName || manifest.productName || manifest.name;
  if (platform === 'macos') {
    const contents = join(folder, `${name}.app`, 'Contents');
    return { executable: join(contents, 'MacOS', name), archive: join(contents, 'Resources', 'app.asar') };
  }
  // Linux's default executable name comes from package.json name, not productName.
  return { executable: join(folder, platform === 'windows' ? `${name}.exe` : manifest.name), archive: join(folder, 'resources', 'app.asar') };
}

async function verifyInstaller(filename, platform, arch) {
  assert(statSync(filename).isFile() && statSync(filename).size > 1_000_000, `Missing or incomplete installer: ${filename}`);
  const bytes = header(filename);
  if (filename.endsWith('.exe')) assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
  if (filename.endsWith('.zip')) assert.equal(bytes.toString('hex', 0, 4), '504b0304');
  if (filename.endsWith('.deb')) assert.equal(bytes.toString('ascii', 0, 8), '!<arch>\n');
  if (filename.endsWith('.AppImage')) assert.equal(binaryArchitecture(bytes, platform), arch, 'AppImage architecture differs from its filename');
  if (filename.endsWith('.dmg')) {
    const descriptor = openSync(filename, 'r');
    try {
      const trailer = Buffer.alloc(4);
      readSync(descriptor, trailer, 0, trailer.length, statSync(filename).size - 512);
      assert.equal(trailer.toString('ascii'), 'koly', 'Invalid DMG trailer');
    } finally { closeSync(descriptor); }
  }
  return { name: basename(filename), bytes: statSync(filename).size, sha256: await sha256(filename) };
}

async function verifyPackage(manifest, platform, arch) {
  const { executable, archive } = packagedPaths(manifest, platform, arch);
  assert.equal(binaryArchitecture(header(executable), platform), arch, 'Packaged runtime architecture differs from the requested target');
  const require = createRequire(import.meta.url);
  const asar = require('@electron/asar');
  const packedManifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(packedManifest.version, manifest.version, 'Packaged version differs from package.json');
  const sourceFiles = ['dist-electron/main.cjs', 'dist-electron/preload.cjs', 'dist-electron/library-worker.cjs', 'LICENSE'];
  function collect(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, item.name);
      if (item.isDirectory()) collect(filename);
      else sourceFiles.push(filename);
    }
  }
  collect('dist');
  for (const filename of sourceFiles) {
    assert(asar.extractFile(archive, filename).equals(readFileSync(filename)), `Packaged file differs from the production build: ${filename}`);
  }
  const forbidden = asar.listPackage(archive).filter(filename => /(?:^|[\\/])(?:\.env(?:\..*)?|session\.enc|test-results)(?:$|[\\/])/.test(filename));
  assert.deepEqual(forbidden, [], 'Private development files found inside app.asar');
  if (platform === 'macos') {
    // Verify nested frameworks and helpers as well as the app's ad-hoc signature.
    execFileSync('codesign', ['--verify', '--deep', '--strict', dirname(dirname(dirname(executable)))], { timeout: 60_000, stdio: 'pipe' });
  }
  const installers = [];
  for (const name of artifactNames(manifest.version, platform, arch)) installers.push(await verifyInstaller(join('release', name), platform, arch));
  return { version: manifest.version, platform, arch, executable, runtimeArchitecture: arch,
    productionFilesCompared: sourceFiles.length, archiveSha256: await sha256(archive), installers,
    ...(platform === 'macos' ? { adHocSignatureVerified: true, developerIdSigned: false, notarized: false } : {}),
    startup: 'Not checked by the structural verification; see the separate smoke report.' };
}

async function smoke(manifest, platform, arch) {
  const nodePlatform = { windows: 'win32', macos: 'darwin', linux: 'linux' }[platform];
  assert.equal(process.platform, nodePlatform, 'Runtime smoke requires the target OS');
  assert.equal(process.arch, arch, 'Runtime smoke requires the target CPU architecture');
  const { _electron: electron } = await import('playwright');
  const { executable } = packagedPaths(manifest, platform, arch);
  const temporaryRoot = realpathSync(tmpdir());
  const profile = mkdtempSync(join(temporaryRoot, 'daily-cf-release-smoke-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await electron.launch({ executablePath: resolve(executable),
      args: [`--user-data-dir=${profile}`, ...(platform === 'linux' ? ['--no-sandbox'] : [])], env, timeout: 30_000 });
    const page = await application.firstWindow();
    await page.waitForFunction(() => Boolean(window.dailyCF?.isDesktop), undefined, { timeout: 20_000 });
    const main = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, arch: process.arch, version: app.getVersion() }));
    const boot = await page.evaluate(async () => {
      const result = await window.dailyCF.bootstrap();
      return { version: result.version, repository: result.repository, oauthConfigured: result.auth.configured,
        signedOut: result.auth.user === null, isolatedRenderer: typeof window.require === 'undefined' };
    });
    assert.equal(main.packaged, true);
    assert.equal(main.arch, arch);
    assert.equal(main.version, manifest.version);
    assert.equal(boot.version, manifest.version);
    assert.equal(boot.repository, repository);
    assert.equal(boot.oauthConfigured, true, 'Browser login is not configured');
    assert.equal(boot.signedOut, true);
    assert.equal(boot.isolatedRenderer, true);
    await page.locator('.sidebar-version').waitFor({ state: 'visible', timeout: 20_000 });
    assert((await page.locator('.sidebar-version').innerText()).includes(manifest.version));
    return { platform, arch, main, boot, renderedVersion: manifest.version,
      scope: 'Packaged application startup, renderer, and preload IPC; no installer or GitHub login interaction.' };
  } finally {
    if (application) await application.close();
    assert.equal(dirname(profile), temporaryRoot);
    assert(basename(profile).startsWith('daily-cf-release-smoke-') && !lstatSync(profile).isSymbolicLink());
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function validateAssetSet(version, names) {
  const expected = platforms.flatMap(platform => architectures.flatMap(arch => artifactNames(version, platform, arch))).sort();
  assert.deepEqual([...names].sort(), expected, 'Release must contain exactly the twelve expected installers');
  return expected;
}

async function main() {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const [command, platform, arch] = process.argv.slice(2);
  if (command === 'metadata') {
    const tag = process.env.RELEASE_TAG;
    assert.equal(tag, `v${manifest.version}`, 'Release tag must match package.json version');
    assert(existsSync(`docs/releases/${tag}.md`), 'Release notes are missing');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
    console.log(`Release ${tag} uses the checked-out source and docs/releases/${tag}.md`);
    return;
  }
  if (command === 'assemble') {
    const directory = resolve(platform || 'installers');
    validateAssetSet(manifest.version, readdirSync(directory));
    const records = [];
    for (const target of platforms) for (const cpu of architectures) for (const name of artifactNames(manifest.version, target, cpu)) {
      records.push(await verifyInstaller(join(directory, name), target, cpu));
    }
    records.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    writeFileSync(join(directory, 'SHA256SUMS.txt'), records.map(item => `${item.sha256}  ${item.name}\n`).join(''));
    console.log(JSON.stringify({ version: manifest.version, installers: records }, null, 2));
    return;
  }
  assert(['package', 'smoke'].includes(command), 'Usage: verify-release.mjs metadata|assemble [directory]|package|smoke <platform> <arch>');
  artifactNames(manifest.version, platform, arch);
  mkdirSync('test-results', { recursive: true });
  const report = `test-results/release-${command}-${platform}-${arch}.json`;
  try {
    const result = command === 'package' ? await verifyPackage(manifest, platform, arch) : await smoke(manifest, platform, arch);
    writeFileSync(report, JSON.stringify({ passed: true, ...result }, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    writeFileSync(report, JSON.stringify({ passed: false, version: manifest.version, platform, arch, error: String(error) }, null, 2) + '\n');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
