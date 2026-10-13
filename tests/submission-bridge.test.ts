import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GitHubClient } from '../electron/github';
import type { BatchSubmissionInput, ClientAPI, SubmissionInput } from '../shared/types';

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

const item: SubmissionInput = { date: '2026-10-07', problemId: 'cf106744g', language: 'cpp', author: 'alice', code: 'int main() {}', notes: '' };
const input: BatchSubmissionInput = { items: [item], notes: '', requestId: 'submission-bridge-test' };

describe('submission list IPC boundary', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('exposes file inspection and new-batch submission without legacy PR mutation methods', async () => {
    await import('../electron/preload');
    const [name, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    expect(name).toBe('dailyCF');
    for (const removed of ['getOpenPullRequests', 'previewSubmission', 'submit']) expect(api).not.toHaveProperty(removed);
    electron.invoke.mockResolvedValue({ ok: true, data: { path: 'remote/path', exists: true } });
    await expect(api.inspectSubmissionFile(item)).resolves.toEqual({ path: 'remote/path', exists: true });
    await api.previewBatchSubmission(input);
    await api.submitBatch(input);
    expect(electron.invoke.mock.calls).toEqual([
      ['daily-cf:inspect-submission-file', item], ['daily-cf:preview-batch', input], ['daily-cf:submit-batch', input],
    ]);
  });

  it('does not retain previous success after an inspection failure', async () => {
    await import('../electron/preload');
    const [, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    electron.invoke.mockResolvedValueOnce({ ok: true, data: { path: 'remote/path', exists: false } })
      .mockResolvedValueOnce({ ok: false, error: 'Remote inspection failed' });
    await api.inspectSubmissionFile(item);
    await expect(api.inspectSubmissionFile(item)).rejects.toThrow('Remote inspection failed');
    expect(electron.invoke).toHaveBeenCalledTimes(2);
  });

  it('preserves actual extensions across import, preview, inspection and submission IPC', async () => {
    await import('../electron/preload');
    const [, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    const imported = { name: 'solution.c++', extension: 'c++', language: 'cpp', code: 'int main() {}' };
    electron.invoke.mockResolvedValueOnce({ ok: true, data: imported });
    await expect(api.importCode()).resolves.toEqual(imported);
    const solution: SubmissionInput = { ...item, language: 'other', extension: 'custom.part' };
    const source: BatchSubmissionInput = { ...input, items: [solution] };
    const path = 'daily_problems/2026/10/1007/personal_submission/cf106744g_alice.custom.part';
    electron.invoke.mockResolvedValue({ ok: true });
    await api.inspectSubmissionFile(solution);
    await api.previewBatchSubmission(source);
    await api.submitBatch({ ...source, overwrites: [{ path, sha: 'a'.repeat(40) }] });
    expect(electron.invoke.mock.calls).toEqual([
      ['daily-cf:import'], ['daily-cf:inspect-submission-file', solution], ['daily-cf:preview-batch', source],
      ['daily-cf:submit-batch', { ...source, overwrites: [{ path, sha: 'a'.repeat(40) }] }],
    ]);
  });

  it('carries full-library snapshots and structured rate-limit errors across the preload', async () => {
    await import('../electron/preload');
    const [, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    const snapshot = { branch: 'main', revision: 'a'.repeat(40), months: [{ month: '2026-10', days: 0 }] };
    const rateLimit = { retryAt: 1_800_000_000_000, resource: 'core', kind: 'primary', authenticated: false };
    electron.invoke.mockResolvedValueOnce({ ok: true, data: snapshot })
      .mockResolvedValueOnce({ ok: false, error: 'Wait for reset', code: 'github_rate_limited', rateLimit });
    await expect(api.getArchiveSnapshot()).resolves.toEqual(snapshot);
    await expect(api.getMonthFromSnapshot('2026-10', snapshot)).rejects.toMatchObject({
      message: 'Wait for reset', code: 'github_rate_limited', rateLimit,
    });
    expect(electron.invoke.mock.calls).toEqual([
      ['daily-cf:archive-snapshot'], ['daily-cf:month-from-snapshot', '2026-10', snapshot],
    ]);
  });

  it('forwards the explicit new-preview error code but not arbitrary remote properties', async () => {
    await import('../electron/preload');
    const [, api] = electron.exposeInMainWorld.mock.calls[0] as [string, ClientAPI];
    electron.invoke.mockResolvedValueOnce({ ok: false, error: 'Re-preview using the latest upstream', code: 'submission_base_changed' })
      .mockResolvedValueOnce({ ok: false, error: 'Unrelated error', code: 'unknown' });
    await expect(api.submitBatch(input)).rejects.toMatchObject({ code: 'submission_base_changed' });
    const second = await api.submitBatch(input).catch(error => error);
    expect(second).not.toHaveProperty('code');
  });

  it('rejects the removed target on both backend entry points before any remote operation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GitHubClient('test-token', { fetch: fetcher });
    const forged = { ...input, target: { kind: 'existing', number: 42, expectedHeadSha: 'a'.repeat(40) } } as unknown as BatchSubmissionInput;
    await expect(client.previewBatchSubmission(forged)).rejects.toThrow();
    await expect(client.submitBatch(forged, 'alice')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    for (const removed of ['getOpenPullRequests', 'previewSubmission', 'submit']) expect(client).not.toHaveProperty(removed);
  });

  it('does not register legacy IPC channels behind the reduced preload surface', () => {
    const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    const channels = [...source.matchAll(/\bhandle\('([^']+)'/g)].map(match => match[1]);
    expect(channels).toContain('inspect-submission-file');
    expect(channels).toContain('submit-batch');
    for (const removed of ['open-pull-requests', 'preview', 'submit']) expect(channels).not.toContain(removed);
  });
});
