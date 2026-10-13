import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import { GitRepository } from './git-repository';
import { GitProblemLibrary } from './git-library';
import { serializeApiError } from '../shared/api-errors';
import { setLocale } from '../shared/i18n';
import { LIBRARY_METHODS, publicLibraryProgress, type LibraryWorkerInput, type LibraryWorkerOutput } from './library-worker-protocol';

if (isMainThread || !parentPort || !workerData || typeof workerData.directory !== 'string' || !isAbsolute(workerData.directory)) {
  throw new Error('The repository reader must run in its dedicated worker.');
}
const port = parentPort;
const post = (message: LibraryWorkerOutput) => port.postMessage(message);
const library = new GitProblemLibrary(new GitRepository(workerData.directory, { onProgress(value) {
  const progress = publicLibraryProgress(value);
  if (progress) post({ type: 'progress', progress });
} }));

// Do not serialize requests here: parallel readers must join the same in-flight
// synchronization in GitRepository and then read their own immutable snapshot.
port.on('message', async (value: LibraryWorkerInput) => {
  if (!value || typeof value !== 'object' || !['zh-CN', 'en'].includes(value.locale)) return;
  setLocale(value.locale);
  if (value.type === 'locale') return;
  if (value.type !== 'request' || !Number.isSafeInteger(value.id) || value.id <= 0 ||
    !LIBRARY_METHODS.includes(value.method) || !Array.isArray(value.args)) return;
  try {
    const method = library[value.method] as (...args: unknown[]) => Promise<unknown>;
    const data = await method.apply(library, value.args);
    post({ type: 'response', id: value.id, result: { ok: true, data } });
  } catch (error) {
    post({ type: 'response', id: value.id, result: serializeApiError(error) });
  }
});
