// Run with Electron: npx electron docs/assets/create-icons.cjs
// Renders the source SVG locally, without network requests or browser tabs.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true,
    show: false, frame: false, transparent: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL('data:text/html,<!DOCTYPE html><title>Local icon renderer</title>');
  const source = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(__dirname, 'icon.svg')).toString('base64');
  const raster = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1024;
      canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('Could not render icon SVG'));
    image.src = ${JSON.stringify(source)};
  })`);
  const image = nativeImage.createFromDataURL(raster);
  const png = (size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(__dirname, 'icon.png'), png(1024));

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const layers = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + 16 * index;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(layers[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += layers[index].length;
  });
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...layers]));

  const entries = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]];
  const chunks = entries.map(([type, size]) => {
    const data = png(size);
    const chunk = Buffer.alloc(8);
    chunk.write(type);
    chunk.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([chunk, data]);
  });
  const icns = Buffer.alloc(8);
  icns.write('icns');
  icns.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  fs.writeFileSync(path.join(__dirname, 'icon.icns'), Buffer.concat([icns, ...chunks]));
  console.log('Generated icon.png, icon.ico and icon.icns from icon.svg');
  window.destroy();
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
