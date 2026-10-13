import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

export interface RetainedReadState<T> {
  data: T | undefined;
  loading: boolean;
  error: string;
  retained: boolean;
  missing: boolean;
}

export interface RetainedReadOptions<T> {
  key: string | null;
  reload?: number;
  load: () => Promise<T>;
  preview?: () => Promise<T | null>;
  initial?: T;
}

type ReadSnapshot<T> = RetainedReadState<T> & { key: string | null; reload: number };
type RetainedValue<T> = { data: T; missing: false } | { missing: true };
const empty = <T>(): RetainedReadState<T> => ({
  data: undefined, loading: false, error: '', retained: false, missing: false,
});
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const isMissing = (reason: unknown) => reason !== null && typeof reason === 'object'
  && 'code' in reason && reason.code === 'library_content_missing';

/** One mounted reader keeps a small working set; nothing is persisted to disk. */
export class RetainedReadController<T> {
  private snapshot: ReadSnapshot<T> = { ...empty<T>(), key: null, reload: 0 };
  private listeners = new Set<() => void>();
  private values = new Map<string, RetainedValue<T>>();
  private generation = 0;

  constructor(private readonly capacity = 8) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(snapshot: ReadSnapshot<T>) {
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }

  private remember(key: string, value: RetainedValue<T>) {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > Math.max(0, this.capacity)) {
      this.values.delete(this.values.keys().next().value!);
    }
  }

  /** Safe to call during render: a different key can never expose the old key's data. */
  view(key: string | null, reload = 0, initial?: T): RetainedReadState<T> {
    if (key === null) return empty<T>();
    if (this.snapshot.key === key && this.snapshot.reload === reload) return this.snapshot;
    // Keep bounded removal tombstones too: a stale card must not resurrect a known
    // deletion after navigating away. Only a successful fresh read can restore it.
    const stored = this.values.get(key);
    const sameKey = this.snapshot.key === key;
    const missing = sameKey ? this.snapshot.missing : stored?.missing === true;
    const data = sameKey ? this.snapshot.data : stored ? stored.missing ? undefined : stored.data : initial;
    return { data, loading: true, error: '', retained: data !== undefined, missing };
  }

  cancel = () => { ++this.generation; };

  start({ key, reload = 0, load, preview, initial }: RetainedReadOptions<T>): Promise<void> {
    const generation = ++this.generation;
    const current = () => this.generation === generation;
    if (key === null) {
      this.publish({ ...empty<T>(), key, reload });
      return Promise.resolve();
    }

    const previous = this.view(key, reload, initial);
    this.publish({ ...previous, key, reload, loading: true, error: '', retained: previous.data !== undefined });
    if (this.values.has(key)) this.remember(key, this.values.get(key)!);
    // Only authoritative success and explicit removal close the preview window.
    // After a transport failure a slower local preview can still provide useful data.
    let authoritative = false;
    if (preview && !previous.missing && previous.data === undefined) {
      void Promise.resolve().then(preview).then(data => {
        if (!current() || authoritative || data === null) return;
        this.remember(key, { data, missing: false });
        this.publish({ ...this.snapshot, data, retained: true, missing: false });
      }).catch(() => { /* The fresh read owns the user-visible failure. */ });
    }

    return Promise.resolve().then(load).then(data => {
      if (!current()) return;
      authoritative = true;
      this.remember(key, { data, missing: false });
      this.publish({ key, reload, data, loading: false, error: '', retained: false, missing: false });
    }).catch(reason => {
      if (!current()) return;
      if (isMissing(reason)) {
        authoritative = true;
        this.remember(key, { missing: true });
        this.publish({ key, reload, ...empty<T>(), error: errorText(reason), missing: true });
      } else {
        this.publish({ ...this.snapshot, loading: false, error: errorText(reason), retained: this.snapshot.data !== undefined });
      }
    });
  }
}

export function useRetainedRead<T>(options: RetainedReadOptions<T>): RetainedReadState<T> {
  const controllerRef = useRef<RetainedReadController<T> | null>(null);
  if (!controllerRef.current) controllerRef.current = new RetainedReadController<T>();
  const controller = controllerRef.current;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { key, reload = 0, initial } = options;
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useLayoutEffect(() => {
    void controller.start({ ...optionsRef.current, key, reload });
    return controller.cancel;
  }, [controller, key, reload]);

  return controller.view(key, reload, initial);
}
