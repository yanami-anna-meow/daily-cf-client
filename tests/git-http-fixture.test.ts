import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { listenForFetch, startGitFixture } from './helpers/git-http-fixture';

function listenerFixture(ports: number[]) {
  const server = new EventEmitter();
  let portIndex = -1;
  return Object.assign(server, {
    listen: vi.fn(() => {
      portIndex++;
      queueMicrotask(() => server.emit('listening'));
      return server;
    }),
    address: () => ({ address: '127.0.0.1', family: 'IPv4', port: ports[Math.min(portIndex, ports.length - 1)] }),
    close: vi.fn((callback: (error?: Error) => void) => {
      queueMicrotask(() => callback());
      return server;
    }),
  });
}

describe('Fetch-compatible Git HTTP fixture port', () => {
  it('releases a forbidden ephemeral port and retries automatic allocation', async () => {
    const server = listenerFixture([6667, 49152]);
    await expect(listenForFetch(server as unknown as Server)).resolves.toMatchObject({ port: 49152 });
    expect(server.listen.mock.calls).toEqual([[0, '127.0.0.1'], [0, '127.0.0.1']]);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.listenerCount('error')).toBe(0);
    expect(server.listenerCount('listening')).toBe(0);
  });

  it('stops after bounded retries and closes each forbidden listener', async () => {
    const server = listenerFixture([10080]);
    await expect(listenForFetch(server as unknown as Server)).rejects.toThrow('accepted by Fetch');
    expect(server.listen).toHaveBeenCalledTimes(32);
    expect(server.close).toHaveBeenCalledTimes(32);
    expect(server.eventNames()).toEqual([]);
  });
});

describe('Git HTTP fixture request bodies', () => {
  it('serves complete discovery responses for repeated concurrent bodyless requests', async () => {
    const fixture = await startGitFixture();
    try {
      const revision = await fixture.runGit(['rev-parse', 'HEAD']);
      for (let batch = 0; batch < 3; batch++) {
        const responses = await Promise.all(Array.from({ length: 8 }, async () => {
          const response = await fetch(`${fixture.url}/info/refs?service=git-upload-pack`);
          return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
        }));
        for (const response of responses) {
          expect(response.status).toBe(200);
          expect(response.type).toBe('application/x-git-upload-pack-advertisement');
          expect(response.body).toContain(`${revision} refs/heads/main`);
          expect(response.body.endsWith('0000')).toBe(true);
        }
      }
      expect(fixture.requests).toHaveLength(24);
      expect(fixture.requests.every(request => request.requestBodyBytes === 0 && request.status === 200)).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it('still delivers nonempty upload-pack requests and returns the requested Git objects', async () => {
    const content = '# Cloned through smart HTTP\n';
    const fixture = await startGitFixture({ 'README.md': content });
    try {
      await fixture.runGit(['-c', 'protocol.version=0', 'clone', fixture.url, 'client'], fixture.directory);
      expect(await readFile(join(fixture.directory, 'client', 'README.md'), 'utf8')).toBe(content);
      const uploads = fixture.requests.filter(request => request.method === 'POST' && request.url === '/remote.git/git-upload-pack');
      expect(uploads.length).toBeGreaterThan(0);
      expect(uploads.every(request => request.requestBodyBytes > 0 && request.responseBodyBytes > 0 && request.status === 200)).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 20_000);
});
