import { submissionExtension, submissionPath, validateSubmission } from '../shared/domain';
import type { Language, Problem, ProblemDay, SubmissionInput } from '../shared/types';

/** Uploaded files only live in App state. Nothing in this module writes to storage. */
export interface SubmissionQueueEntry {
  key: string;
  ordinal: number;
  problem: Problem;
  input: SubmissionInput;
  fileName: string;
  unavailable?: boolean;
}

export function createQueueEntry(day: ProblemDay, problem: Problem, language: Language, entries: readonly SubmissionQueueEntry[], key: string = crypto.randomUUID()): SubmissionQueueEntry {
  const ordinal = Math.max(0, ...entries.filter(entry => entry.input.date === day.date && entry.input.problemId === problem.id).map(entry => entry.ordinal)) + 1;
  return { key, ordinal, problem, fileName: '', input: { date: day.date, problemId: problem.id, language, extension: submissionExtension({ language }), author: '', code: '', notes: '' } };
}

export function queueEditorDirty(entry: SubmissionQueueEntry | null, original: SubmissionQueueEntry | null): boolean {
  if (!entry) return false;
  if (!original) return Boolean(entry.fileName || entry.input.code || entry.input.author.trim() || entry.input.notes.trim());
  return entry.fileName !== original.fileName || (Object.keys(entry.input) as (keyof SubmissionInput)[]).some(key => entry.input[key] !== original.input[key]);
}

export function normalizeQueueEntry(entry: SubmissionQueueEntry): SubmissionQueueEntry {
  return { ...entry, input: validateSubmission(entry.input) };
}

export function findQueueConflict(entries: readonly SubmissionQueueEntry[], incoming: SubmissionQueueEntry): SubmissionQueueEntry | undefined {
  const path = submissionPath(incoming.input);
  return entries.find(entry => entry.key !== incoming.key && submissionPath(entry.input) === path);
}

/** A replacement must name the conflicting entry, so no same-path file is silently discarded. */
export function putQueueEntry(entries: readonly SubmissionQueueEntry[], incoming: SubmissionQueueEntry, confirmedReplacement?: string): SubmissionQueueEntry[] {
  const normalized = normalizeQueueEntry(incoming);
  const conflict = findQueueConflict(entries, normalized);
  if (conflict && conflict.key !== confirmedReplacement) throw new Error('Queue replacement requires confirmation');
  if (confirmedReplacement && !conflict) throw new Error('The queue replacement no longer matches');
  const existingIndex = entries.findIndex(entry => entry.key === normalized.key);
  const replacedIndex = conflict ? entries.findIndex(entry => entry.key === conflict.key) : -1;
  const position = existingIndex >= 0 ? existingIndex : replacedIndex >= 0 ? replacedIndex : entries.length;
  const next: SubmissionQueueEntry[] = [];
  for (let index = 0; index < entries.length; index++) {
    if (index === position) next.push(normalized);
    if (entries[index].key !== normalized.key && entries[index].key !== conflict?.key) next.push(entries[index]);
  }
  if (position === entries.length) next.push(normalized);
  return next;
}
