import { useEffect, useState, useSyncExternalStore } from 'react';
import { validateDate } from '../shared/domain';
import type { ClientAPI, ProblemDay } from '../shared/types';
import { api } from './bridge';

export const COMPOSER_DATE_DEBOUNCE_MS = 400;
export type ComposerDayStatus = 'idle' | 'waiting' | 'loading' | 'ready' | 'error';
export interface ComposerDaySnapshot {
  date: string;
  day: ProblemDay | null;
  status: ComposerDayStatus;
  error: string;
}

export function isCompleteComposerDate(date: string): boolean {
  try { return validateDate(date) === date; } catch { return false; }
}

/** Holds only the current selector result. Returning to a date always reads it again. */
export class ComposerDayPickerController {
  private snapshot: ComposerDaySnapshot;
  private readonly listeners = new Set<() => void>();
  private selection: string | undefined;
  private active = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly client: Pick<ClientAPI, 'getDay'>, initialDate?: string) {
    // Undefined means the initial latest-day request; an empty user input never does.
    this.selection = initialDate;
    this.snapshot = { date: initialDate ?? '', day: null, status: 'idle', error: '' };
  }

  getSnapshot = (): ComposerDaySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(snapshot: ComposerDaySnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private invalidate(): void {
    ++this.generation;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Resume is safe after effect cleanup, including React StrictMode setup replay. */
  resume = (): void => {
    if (this.active) return;
    this.active = true;
    this.refresh();
  };

  suspend = (): void => {
    this.active = false;
    this.invalidate();
    this.publish({ date: this.snapshot.date, day: null, status: 'idle', error: '' });
  };

  select = (date: string): void => {
    if (date === this.selection) return;
    this.selection = date;
    this.invalidate();
    const ready = isCompleteComposerDate(date);
    this.publish({ date, day: null, status: ready && this.active ? 'waiting' : 'idle', error: '' });
    if (!ready || !this.active) return;
    // Browser date fields can emit several padded years while a year is being typed.
    // Debounce those valid intermediate values without forbidding older/future dates.
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.active && generation === this.generation) void this.read(date, generation);
    }, COMPOSER_DATE_DEBOUNCE_MS);
  };

  refresh = (): void => {
    if (!this.active || this.snapshot.status === 'loading') return;
    this.invalidate();
    const date = this.selection;
    if (date !== undefined && !isCompleteComposerDate(date)) {
      this.publish({ date, day: null, status: 'idle', error: '' });
      return;
    }
    void this.read(date, this.generation);
  };

  private async read(date: string | undefined, generation: number): Promise<void> {
    this.publish({ date: date ?? '', day: null, status: 'loading', error: '' });
    try {
      const next = await this.client.getDay(date, true);
      if (!this.active || generation !== this.generation) return;
      if (!isCompleteComposerDate(next.date)) throw new Error('读取到的题目日期无效，请重试。');
      if (date !== undefined && next.date !== date) throw new Error('返回的题目日期与所选日期不一致，请重试。');
      this.selection = next.date;
      this.publish({ date: next.date, day: next, status: 'ready', error: '' });
    } catch (reason) {
      if (!this.active || generation !== this.generation) return;
      this.publish({ date: date ?? '', day: null, status: 'error', error: reason instanceof Error ? reason.message : String(reason) });
    }
  }
}

export function useComposerDayPicker(initialDate: string | undefined, enabled: boolean) {
  const [controller] = useState(() => new ComposerDayPickerController(api, initialDate));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    if (enabled) controller.resume();
    else controller.suspend();
    return controller.suspend;
  }, [controller, enabled]);
  return { ...state, select: controller.select, refresh: controller.refresh };
}
