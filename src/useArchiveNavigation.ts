import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchiveMonth, ProblemDay } from '../shared/types';
import { t, useLocale } from './i18n';

type Target = { kind: 'month' | 'date'; value: string; id: number };
type Notice = { text: string; waiting: boolean } | null;

/** Navigation only: this hook never fetches data or changes the archive filters. */
export function useArchiveNavigation({ active, months, index, matches, loading, failedMonths, directoryError, stopped }: {
  active: boolean; months: ArchiveMonth[]; index: Record<string, ProblemDay[]>;
  matches: ProblemDay[]; loading: boolean; failedMonths: ReadonlySet<string>;
  directoryError: boolean; stopped: boolean;
}) {
  const locale = useLocale();
  const [target, setTarget] = useState<Target | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [activeMonth, setActiveMonth] = useState('');
  const [locatedDate, setLocatedDate] = useState('');
  const serial = useRef(0);
  const waiting = useRef(false);
  const cancel = useCallback(() => {
    ++serial.current; waiting.current = false; setTarget(null); setNotice(null);
  }, []);
  const jump = useCallback((kind: Target['kind'], value: string) => {
    waiting.current = false; setNotice(null);
    setLocatedDate(kind === 'date' ? value : '');
    setTarget({ kind, value, id: ++serial.current });
  }, []);

  useEffect(() => {
    if (!active) { cancel(); return; }
    // A pending asynchronous jump must not pull the reader back after they move on.
    const onScroll = () => { if (waiting.current) cancel(); };
    const onIntent = () => { if (target) cancel(); };
    const onKey = (event: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)
        && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement)) onIntent();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onIntent, { passive: true });
    window.addEventListener('touchstart', onIntent, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll); window.removeEventListener('wheel', onIntent);
      window.removeEventListener('touchstart', onIntent); window.removeEventListener('keydown', onKey);
    };
  }, [active, cancel, target]);

  useEffect(() => {
    if (!active || !target) return;
    const month = target.kind === 'month' ? target.value : target.value.slice(0, 7);
    const loaded = Object.hasOwn(index, month);
    if (!loaded && loading && !failedMonths.has(month)) {
      waiting.current = true;
      setNotice({ text: t('正在等待 {{target}} 的题目加载…', { target: target.value }), waiting: true });
      return;
    }
    waiting.current = false;
    const finish = (text: string) => { setNotice({ text, waiting: false }); setTarget(null); };
    if (!loaded) {
      finish(failedMonths.has(month) || directoryError || stopped || months.some(entry => entry.month === month)
        ? t('{{target}} 尚未加载，请完成题库加载后重试。', { target: target.value })
        : t('题库中没有 {{target}} 的题目。', { target: target.value }));
      return;
    }
    const day = matches.find(day => target.kind === 'date' ? day.date === target.value : day.date.startsWith(month));
    if (!day) {
      const exists = index[month].some(day => (target.kind === 'month' || day.date === target.value) && day.problems.length > 0);
      finish(exists ? t('{{target}} 的题目被当前筛选隐藏。', { target: target.value }) : t('题库中没有 {{target}} 的题目。', { target: target.value }));
      return;
    }
    const section = document.querySelector<HTMLElement>(`[data-problem-date="${day.date}"]`);
    if (!section) return;
    setNotice(null);
    const id = target.id;
    // Reveal the target before measuring. The second frame settles any nearby
    // content-visibility placeholders without rendering the entire archive.
    section.classList.add('archive-navigation-target');
    let second = 0;
    const first = requestAnimationFrame(() => {
      if (serial.current !== id) { section.classList.remove('archive-navigation-target'); return; }
      const align = () => {
        const offset = window.innerWidth <= 650 ? (document.querySelector('.months-panel')?.getBoundingClientRect().height ?? 0) + 24 : 24;
        window.scrollTo({ top: window.scrollY + section.getBoundingClientRect().top - offset, behavior: 'instant' });
      };
      align();
      second = requestAnimationFrame(() => {
        if (serial.current !== id) { section.classList.remove('archive-navigation-target'); return; }
        align();
        setActiveMonth(month); setNotice(null); setTarget(null);
        section.classList.remove('archive-navigation-target');
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); section.classList.remove('archive-navigation-target'); };
  }, [active, target, months, index, matches, loading, failedMonths, directoryError, stopped, locale]);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const sections = [...document.querySelectorAll<HTMLElement>('[data-archive-month]')];
      const offset = window.innerWidth <= 650 ? (document.querySelector('.months-panel')?.getBoundingClientRect().height ?? 0) + 24 : 32;
      let current = sections[0]?.dataset.archiveMonth ?? '';
      for (const section of sections) {
        if (section.getBoundingClientRect().top > offset) break;
        current = section.dataset.archiveMonth ?? current;
      }
      const last = sections.at(-1);
      if (last && window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 3
        && last.getBoundingClientRect().top < window.innerHeight) current = last.dataset.archiveMonth ?? current;
      setActiveMonth(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    schedule(); window.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [active, matches]);

  useEffect(() => {
    if (!active || !activeMonth) return;
    const button = document.querySelector<HTMLElement>(`[data-month-jump="${activeMonth}"]`);
    const list = button?.closest<HTMLElement>('.months-list');
    if (!button || !list) return;
    const item = button.getBoundingClientRect(); const viewport = list.getBoundingClientRect();
    if (window.innerWidth <= 650) {
      if (item.left < viewport.left || item.right > viewport.right) list.scrollLeft += item.left - viewport.left;
    } else if (item.top < viewport.top || item.bottom > viewport.bottom) list.scrollTop += item.top - viewport.top;
  }, [active, activeMonth]);

  return { activeMonth, locatedDate, notice, jump, cancel };
}
