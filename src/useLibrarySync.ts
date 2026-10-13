import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { LibrarySyncProgress } from '../shared/types';
import { api } from './bridge';

/** Progress describes synchronization only; this hook never stores repository contents. */
export function useLibrarySync() {
  const [progress, setProgress] = useState<LibrarySyncProgress | null>(null);
  const active = useRef(false);
  const request = useRef(0);
  const terminalVersion = useRef(0);

  // Register before the page's layout effect starts its first repository read.
  useLayoutEffect(() => {
    active.current = true;
    const unsubscribe = api.onLibrarySync(next => {
      if (!active.current) return;
      if (next.phase === 'ready' || next.phase === 'error') ++terminalVersion.current;
      setProgress(next);
    });
    return () => { active.current = false; ++request.current; unsubscribe(); };
  }, []);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    const startedAtVersion = terminalVersion.current;
    try { await api.syncLibrary(); }
    catch (reason) {
      // Worker completion is authoritative, including a newer content page's
      // sync. A late IPC rejection must not replace it or the next sync's progress.
      // Only supply a fallback when no worker completion reached this subscriber.
      if (active.current && current === request.current && terminalVersion.current === startedAtVersion) setProgress({
        phase: 'error', completed: 0, unit: 'objects',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, []);

  return { progress, refresh, busy: Boolean(progress && progress.phase !== 'ready' && progress.phase !== 'error') };
}
