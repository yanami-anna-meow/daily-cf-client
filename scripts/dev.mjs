import { spawn } from 'node:child_process';
import electron from 'electron';
import './build-electron.mjs';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit', env, windowsHide: true });
let desktop;
const cleanup = () => { vite.kill(); desktop?.kill(); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup); process.on('exit', cleanup);
for (let attempt = 0; attempt < 100; attempt++) {
  try { if ((await fetch('http://127.0.0.1:5173')).ok) break; } catch {}
  if (attempt === 99) { cleanup(); throw new Error('Vite startup timed out'); }
  await new Promise(r => setTimeout(r, 150));
}
desktop = spawn(electron, ['.'], { stdio: 'inherit', env: { ...env, DAILY_CF_DEV_URL: 'http://127.0.0.1:5173' }, windowsHide: true });
desktop.on('exit', (code) => { cleanup(); process.exit(code ?? 0); });
