const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function icoImages(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) throw new Error('Invalid ICO header.');
  return Array.from({ length: buffer.readUInt16LE(4) }, (_, index) => {
    const position = 6 + index * 16;
    const offset = buffer.readUInt32LE(position + 12), size = buffer.readUInt32LE(position + 8);
    return { width: buffer[position] || 256, height: buffer[position + 1] || 256,
      data: buffer.subarray(offset, offset + size) };
  });
}

function peResources(buffer) {
  const pe = buffer.readUInt32LE(0x3c);
  if (buffer.toString('ascii', 0, 2) !== 'MZ' || buffer.readUInt32LE(pe) !== 0x4550) throw new Error('Invalid PE image.');
  const optional = pe + 24, magic = buffer.readUInt16LE(optional);
  const directory = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : (() => { throw new Error('Unknown PE format.'); })());
  const sectionTable = optional + buffer.readUInt16LE(pe + 20);
  const sections = Array.from({ length: buffer.readUInt16LE(pe + 6) }, (_, index) => {
    const position = sectionTable + index * 40;
    return { virtual: buffer.readUInt32LE(position + 12), size: Math.max(buffer.readUInt32LE(position + 8), buffer.readUInt32LE(position + 16)),
      file: buffer.readUInt32LE(position + 20) };
  });
  const rvaOffset = rva => {
    const section = sections.find(item => rva >= item.virtual && rva < item.virtual + item.size);
    if (!section) throw new Error('PE resource RVA is outside sections.');
    return section.file + rva - section.virtual;
  };
  const root = rvaOffset(buffer.readUInt32LE(directory + 16));
  const entries = [];
  const walk = (relative, parents) => {
    if (parents.length > 3) throw new Error('Invalid PE resource depth.');
    const offset = root + relative;
    const count = buffer.readUInt16LE(offset + 12) + buffer.readUInt16LE(offset + 14);
    for (let index = 0; index < count; index++) {
      const position = offset + 16 + index * 8;
      const name = buffer.readUInt32LE(position), target = buffer.readUInt32LE(position + 4);
      const nameOffset = root + (name & 0x7fffffff);
      const id = name >>> 31 ? buffer.toString('utf16le', nameOffset + 2, nameOffset + 2 + buffer.readUInt16LE(nameOffset) * 2) : name;
      const ids = [...parents, id];
      if (target >>> 31) walk(target & 0x7fffffff, ids);
      else {
        const descriptor = root + target;
        const dataOffset = rvaOffset(buffer.readUInt32LE(descriptor)), size = buffer.readUInt32LE(descriptor + 4);
        if (dataOffset + size > buffer.length) throw new Error('PE resource exceeds file size.');
        entries.push({ ids, data: buffer.subarray(dataOffset, dataOffset + size) });
      }
    }
  };
  walk(0, []);
  return entries;
}

function verifyEmbeddedIcons(workspace, executable, version) {
  const sourcePath = path.join(workspace, 'docs/assets/icon.ico');
  const source = fs.readFileSync(sourcePath), images = icoImages(source);
  const paths = [executable, path.join(workspace, `release/Daily-CF-${version}-windows-x86_64-nsis.exe`),
    path.join(workspace, `release/Daily-CF-${version}-windows-x86_64-portable.exe`)];
  const artifacts = paths.map(file => {
    const resources = peResources(fs.readFileSync(file));
    const groups = resources.filter(item => item.ids[0] === 14);
    if (!groups.length) throw new Error('No group icon found in ' + file);
    const checks = groups.map(group => {
      const count = group.data.readUInt16LE(4);
      const layers = Array.from({ length: count }, (_, index) => {
        const offset = 6 + index * 14;
        const id = group.data.readUInt16LE(offset + 12);
        const width = group.data[offset] || 256, height = group.data[offset + 1] || 256;
        const icon = resources.find(item => item.ids[0] === 3 && item.ids[1] === id && item.ids[2] === group.ids[2]);
        const expected = images.find(item => item.width === width && item.height === height);
        return { width, height, resourceId: id, exactSourceMatch: Boolean(icon && expected && icon.data.equals(expected.data)),
          sha256: icon ? hash(icon.data) : null };
      });
      return { resource: group.ids, allSourceLayers: count === images.length && layers.every(item => item.exactSourceMatch), layers };
    });
    // The first icon group is the application's default file icon.
    if (!checks[0].allSourceLayers) throw new Error('Default executable icon does not exactly match the regenerated ICO: ' + file);
    return { path: path.relative(workspace, file).replaceAll('\\', '/'), defaultGroupExactSourceMatch: true, groups: checks };
  });
  return { passed: true, source: 'docs/assets/icon.ico', sourceSha256: hash(source),
    method: 'Read PE RT_GROUP_ICON and RT_ICON resources; default group image bytes must equal every ICO layer.',
    resolutions: images.map(item => item.width), artifacts };
}

async function verifyNativeWindowIcon(application, workspace, version) {
  const handle = await application.evaluate(({ BrowserWindow }) => {
    const data = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
    return (data.length >= 8 ? data.readBigUInt64LE() : BigInt(data.readUInt32LE())).toString();
  });
  const output = path.join(workspace, `test-results/program-window-icon-${version}.png`);
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(workspace, 'docs/assets/read-native-window-icon.ps1'), '-WindowHandle', handle, '-OutputPath', output],
  { windowsHide: true, timeout: 15_000, encoding: 'utf8' });
  const result = JSON.parse(stdout.trim());
  if (!result.passed) throw new Error('Native window icon is missing or does not contain the expected green colors.');
  return { ...result, screenshotOfTaskbarTaken: false, output: path.relative(workspace, output).replaceAll('\\', '/') };
}

module.exports = { verifyEmbeddedIcons, verifyNativeWindowIcon };
