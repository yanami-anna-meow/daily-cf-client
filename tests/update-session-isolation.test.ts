import { describe, expect, it } from 'vitest';
import { shouldExpireGitHubSession } from '../electron/ipc-errors';

describe('anonymous update requests and contribution login', () => {
  it.each(['state', 'check', 'download', 'cancel', 'open', 'reveal'])('does not expire the account after an update %s failure', action => {
    expect(shouldExpireGitHubSession(`app-update-${action}`, { status: 401 }, 'session', 'session')).toBe(false);
  });
  it('still expires a contribution session for its own unauthorized request', () => {
    expect(shouldExpireGitHubSession('submit-batch', { status: 401 }, 'session', 'session')).toBe(true);
    expect(shouldExpireGitHubSession('submit-batch', { status: 401 }, 'old', 'current')).toBe(false);
  });
});
