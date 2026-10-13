import { build } from 'esbuild';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const repository = process.env.DAILY_CF_REPOSITORY || 'Yawn-Sean/Daily_CF_Problems';
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid DAILY_CF_REPOSITORY');
await build({ entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/library-worker.ts'], outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true, define: { __GITHUB_CLIENT_ID__: JSON.stringify(process.env.GITHUB_CLIENT_ID || ''), __DAILY_CF_REPOSITORY__: JSON.stringify(repository) } });
