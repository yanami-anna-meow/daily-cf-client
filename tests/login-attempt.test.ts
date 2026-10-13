import { describe, expect, it } from 'vitest';
import { LoginAttemptLock } from '../electron/login-attempt';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function validateToken(lock: LoginAttemptLock, generation: number, response: Promise<void>) {
  lock.acquire(generation);
  try {
    await response;
  } finally {
    lock.release(generation);
  }
}

describe('login attempt ownership', () => {
  it('starts inactive and allows repeated cancellation before and after acquiring', () => {
    const lock = new LoginAttemptLock();
    expect(lock.active).toBe(false);
    lock.clear();
    lock.clear();
    expect(lock.active).toBe(false);

    lock.acquire(0);
    expect(lock.active).toBe(true);
    lock.clear();
    lock.clear();
    expect(lock.active).toBe(false);

    lock.acquire(1);
    expect(lock.active).toBe(true);
  });

  it('rejects overlapping attempts without replacing the current owner', () => {
    const lock = new LoginAttemptLock();
    lock.acquire(10);

    expect(() => lock.acquire(10)).toThrow();
    expect(() => lock.acquire(11)).toThrow();
    lock.release(11);
    expect(lock.active).toBe(true);

    lock.release(10);
    expect(lock.active).toBe(false);
    expect(() => lock.acquire(11)).not.toThrow();
    expect(lock.active).toBe(true);
  });

  it('ignores a stale release both while inactive and after a new attempt starts', () => {
    const lock = new LoginAttemptLock();
    lock.acquire(1);
    lock.clear();
    lock.release(1);
    expect(lock.active).toBe(false);

    lock.acquire(2);
    lock.release(1);
    expect(lock.active).toBe(true);
    lock.release(2);
    lock.release(2);
    expect(lock.active).toBe(false);
  });

  it.each(['success', 'failure'] as const)('releases the current request after %s', async outcome => {
    const lock = new LoginAttemptLock();
    const response = deferred();
    const error = new Error('Token validation failed');
    const request = validateToken(lock, 1, response.promise);
    expect(lock.active).toBe(true);

    if (outcome === 'success') {
      response.resolve();
      await expect(request).resolves.toBeUndefined();
    } else {
      response.reject(error);
      await expect(request).rejects.toBe(error);
    }

    expect(lock.active).toBe(false);
    expect(() => lock.acquire(2)).not.toThrow();
  });

  it.each(['success', 'failure'] as const)(
    'allows immediate retry after cancellation and keeps the new request locked after old %s',
    async outcome => {
      const lock = new LoginAttemptLock();
      const oldResponse = deferred();
      const oldRequest = validateToken(lock, 1, oldResponse.promise);
      expect(lock.active).toBe(true);

      // Cancellation must reopen the Device Flow gate before the old network call finishes.
      lock.clear();
      expect(lock.active).toBe(false);

      // A PAT retry can acquire the lock immediately even if the old fetch ignores abort.
      const newResponse = deferred();
      const newRequest = validateToken(lock, 2, newResponse.promise);
      expect(lock.active).toBe(true);

      if (outcome === 'success') {
        oldResponse.resolve();
        await expect(oldRequest).resolves.toBeUndefined();
      } else {
        const error = new Error('Cancelled request eventually failed');
        oldResponse.reject(error);
        await expect(oldRequest).rejects.toBe(error);
      }

      expect(lock.active).toBe(true);
      expect(() => lock.acquire(3)).toThrow();

      newResponse.resolve();
      await expect(newRequest).resolves.toBeUndefined();
      expect(lock.active).toBe(false);
      expect(() => lock.acquire(3)).not.toThrow();
    },
  );
});
