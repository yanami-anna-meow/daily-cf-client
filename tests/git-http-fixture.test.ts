import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { listenForFetch } from './helpers/git-http-fixture';

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
