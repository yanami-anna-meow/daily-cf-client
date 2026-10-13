import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const repository = process.env.DAILY_CF_REPOSITORY || env.DAILY_CF_REPOSITORY || 'Yawn-Sean/Daily_CF_Problems';
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid DAILY_CF_REPOSITORY');
  return {
    plugins: [react()], base: './', define: { __DAILY_CF_REPOSITORY__: JSON.stringify(repository) },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    // Real filesystem and Git fixtures need bounded headroom on shared runners.
    // Individual test limits and production sync timeouts remain independent.
    test: { testTimeout: 30_000, hookTimeout: 60_000 },
  };
});
