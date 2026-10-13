import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { CalendarDays, CheckCircle2, ChevronDown, CircleHelp, FileCode2, GitPullRequest, ListPlus, LoaderCircle, Pencil, Plus, RefreshCw, Send, Trash2, Upload } from 'lucide-react';
import { api } from '../bridge';
import { t } from '../../shared/i18n';
import { useLocale } from '../i18n';
import { isCompleteComposerDate, useComposerDayPicker } from '../useComposerDayPicker';
import { LANGUAGES, type AuthState, type BatchSubmissionInput, type BatchSubmissionPreview, type BatchSubmissionResult, type Language, type Problem, type ProblemDay, type RemotePullRequest, type Settings, type SubmissionInput, type SubmissionProgress } from '../../shared/types';
import { createQueueEntry, findQueueConflict, normalizeQueueEntry, putQueueEntry, queueEditorDirty, type SubmissionQueueEntry } from '../submissionQueue';
import CodeHighlight from './CodeHighlight';
import Modal from './Modal';
import ProblemContributionStatus from './ProblemContributionStatus';
import CodeDiff from './CodeDiff';
import ForkSettings from './ForkSettings';
import QueuePreview from './QueuePreview';
import { submissionExtension, submissionFileName, submissionPath, validateSubmission } from '../../shared/domain';
import { extensionLanguageLabel, importExtension, languageForExtension, normalizeExtension } from '../../shared/file-formats';

type Entry = SubmissionQueueEntry;
interface Props {
  day?: ProblemDay; problem?: Problem;
  entries: Entry[]; onEntriesChange: Dispatch<SetStateAction<Entry[]>>;
  notes: string; onNotesChange: (notes: string) => void; requestId: string;
  settings: Settings; auth: AuthState; repository: string;
  records: RemotePullRequest[]; statusIncomplete: boolean;
  onClose: () => void; closeRequestRef?: RefObject<((action: () => void) => void) | null>;
  onEditingChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void;
  onLogin: () => void; onSubmitted: (result: BatchSubmissionResult) => void;
  onResetRequestId: () => void;
  onSettingsSaved: (settings: Settings) => void; renderMetadata: (problem: Problem) => ReactNode;
}
interface PendingAdd { entry: Entry; path: string; exists: boolean | null; conflict?: Entry; }
const MAX_ITEMS = 50;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const problemKey = (date: string, problem: Problem) => `${date}/${problem.id.toLowerCase()}`;
function fileFormatLabel(input: SubmissionInput): string {
  try { return extensionLanguageLabel(submissionExtension(input)); }
  catch { return t('未识别'); }
}
function extensionLanguage(value: string): Language {
  try { return languageForExtension(normalizeExtension(value)); }
  catch { return 'other'; }
}
export function refreshComposerEntries(items: Entry[], day: ProblemDay): Entry[] {
  return items.map(item => {
    if (item.input.date !== day.date) return item;
    const fresh = day.problems.find(candidate => candidate.id === item.input.problemId);
    return fresh ? { ...item, problem: fresh, unavailable: false } : { ...item, unavailable: true };
  });
}
function filenamePreview(input: SubmissionInput): { name: string; error: string; authorError: string; extensionError: string } {
  const preview = { name: '', error: '', authorError: '', extensionError: '' };
  try { submissionExtension(input); }
  catch (reason) { preview.extensionError = errorText(reason); }
  if (!input.author.trim()) return preview;
  // Validate the signature separately so extension errors never mark its field invalid.
  try { submissionFileName({ ...input, extension: 'txt' }); }
  catch (reason) { preview.authorError = errorText(reason); }
  if (preview.authorError || preview.extensionError) return preview;
  try { preview.name = submissionFileName(input); }
  catch (reason) { preview.error = errorText(reason); }
  return preview;
}

export default function BatchComposer({ day, problem, entries: items, onEntriesChange: setItems, notes, onNotesChange: setNotes, requestId, settings, auth, repository, records, statusIncomplete, onClose, closeRequestRef, onEditingChange, onBusyChange, onLogin, onSubmitted, onResetRequestId, onSettingsSaved, renderMetadata }: Props) {
  const [editor, setEditor] = useState<Entry | null>(() => day && problem ? createQueueEntry(day, problem, settings.language, items) : null);
  const [editorOriginal, setEditorOriginal] = useState<Entry | null>(null);
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [forkSetupOpen, setForkSetupOpen] = useState(false);
  const [forkCandidate, setForkCandidate] = useState('');
  const [forkSaving, setForkSaving] = useState(false);
  const [forkWorking, setForkWorking] = useState(false);
  const forkWorkingRef = useRef(false);
  const forkSavingRef = useRef(false);
  const [forkError, setForkError] = useState('');
  const [closeRequested, setCloseRequested] = useState(false);
  const pendingCloseAction = useRef<(() => void) | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [preview, setPreview] = useState<BatchSubmissionPreview | null>(null);
  const [confirmedOverwrites, setConfirmedOverwrites] = useState<Set<string>>(new Set());
  const [previewBusy, setPreviewBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<SubmissionProgress | null>(null);
  const mounted = useRef(true);
  const operationBusy = useRef(false);
  const previewLogin = useRef('');
  const account = useRef(auth.user?.login || '');
  account.current = auth.user?.login || '';
  const busy = previewBusy || submitBusy || importBusy || inspectBusy || forkSaving || forkWorking;
  const locked = busy || Boolean(preview);
  const dirty = queueEditorDirty(editor, editorOriginal);
  const picker = useComposerDayPicker(day?.date, !editor && !forkSetupOpen && !preview);
  const pickerDay = picker.day;
  const pickerDate = picker.date;
  const dayError = picker.error;
  const dayBusy = picker.status === 'waiting' || picker.status === 'loading';
  const validPickerDate = isCompleteComposerDate(pickerDate);
  const pickerStatusId = useId();
  const problemCount = new Set(items.map(item => problemKey(item.input.date, item.problem))).size;
  const totalBytes = items.reduce((sum, item) => sum + new TextEncoder().encode(item.input.code).byteLength, 0);
  const locale = useLocale();
  const normalizedInputs = useMemo(() => {
    const result = new Map<string, SubmissionInput>();
    for (const item of items) {
      try { const normalized = validateSubmission(item.input); result.set(submissionPath(normalized), normalized); }
      catch { /* The backend validates again before publishing. */ }
    }
    return result;
  }, [items]);
  const canPreview = items.length > 0 && normalizedInputs.size === items.length;
  const overwriteFiles = preview?.items.filter(file => file.existing && !file.unchanged) || [];
  const allOverwritesConfirmed = overwriteFiles.every(file => Boolean(file.previous?.sha) && confirmedOverwrites.has(file.path));
  const canSubmit = Boolean(preview?.items.every(file => normalizedInputs.has(file.path))) && allOverwritesConfirmed && preview?.forkSync?.state !== 'diverged' && Boolean(preview?.items.some(file => !file.unchanged));

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pendingCloseAction.current = null; }; }, []);
  useImperativeHandle(closeRequestRef, () => requestClose);
  useEffect(() => api.onSubmissionProgress(setProgress), []);
  useEffect(() => { onEditingChange?.(dirty); return () => onEditingChange?.(false); }, [dirty, onEditingChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!pickerDay || locked) return;
    setItems(current => refreshComposerEntries(current, pickerDay));
  }, [pickerDay, locked, setItems]);
  useEffect(() => {
    if (preview && previewLogin.current !== (auth.user?.login || '')) {
      setPreview(null); setConfirmedOverwrites(new Set()); setError('GitHub 账号已变化，请重新预览。');
    }
  }, [auth.user?.login, preview]);

  async function bindFork() {
    if (!forkCandidate || forkSavingRef.current || forkWorkingRef.current || !auth.user) return;
    const login = account.current;
    forkSavingRef.current = true; setForkSaving(true); setForkError('');
    try {
      const verified = await api.validateFork(forkCandidate);
      if (!mounted.current || account.current !== login) throw new Error('GitHub 账号已变化，请重新选择 Fork。');
      const saved = await api.saveSettings({ ...settings, forkRepository: verified.fullName });
      if (mounted.current && account.current === login) { onSettingsSaved(saved); setForkSetupOpen(false); setForkCandidate(''); setPreview(null); setConfirmedOverwrites(new Set()); setError(''); }
    } catch (reason) { if (mounted.current) setForkError(errorText(reason)); }
    finally { forkSavingRef.current = false; if (mounted.current) setForkSaving(false); }
  }
  function onForkBusyChange(value: boolean) { forkWorkingRef.current = value; if (mounted.current) setForkWorking(value); }
  function requestClose(action: () => void = onClose) {
    if (busy || operationBusy.current || forkWorkingRef.current || forkSavingRef.current) return;
    pendingCloseAction.current = null;
    if (dirty) { pendingCloseAction.current = action; setCloseRequested(true); }
    else { setCloseRequested(false); action(); }
  }
  function cancelClose() { pendingCloseAction.current = null; setCloseRequested(false); }
  function confirmClose() { const action = pendingCloseAction.current; pendingCloseAction.current = null; setCloseRequested(false); action?.(); }
  function leaveEditor() { setEditor(null); setEditorOriginal(null); setPendingAdd(null); setError(''); }
  function updateEditor(patch: Partial<SubmissionInput>) {
    setEditor(current => current ? { ...current, input: { ...current.input, ...patch } } : null);
    setPendingAdd(null); setError('');
  }
  function chooseLanguage(value: string) {
    const language = LANGUAGES.find(item => item.id === value);
    if (language) updateEditor({ language: language.id, extension: language.extension });
  }
  function changeExtension(extension: string) { updateEditor({ extension, language: extensionLanguage(extension) }); }
  function addItem(candidate: Problem) {
    if (!pickerDay || pickerDay.date !== pickerDate || dayBusy || locked || items.length >= MAX_ITEMS) return;
    setEditor(createQueueEntry(pickerDay, candidate, settings.language, items)); setEditorOriginal(null); setPendingAdd(null); setError('');
  }
  function editItem(item: Entry) { setEditor({ ...item, input: { ...item.input } }); setEditorOriginal(item); setPendingAdd(null); setError(''); }
  async function importCode() {
    if (!editor || busy || operationBusy.current) return;
    operationBusy.current = true; setImportBusy(true); setError(''); setPendingAdd(null);
    try {
      const file = await api.importCode();
      if (file && mounted.current) {
        const extension = file.extension ?? importExtension(file.name);
        setEditor(current => current ? { ...current, fileName: file.name, input: { ...current.input, code: file.code, extension, language: extensionLanguage(extension) } } : null);
      }
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { operationBusy.current = false; if (mounted.current) setImportBusy(false); }
  }
  function commitEntry(pending: PendingAdd) {
    const conflict = findQueueConflict(items, pending.entry);
    if (conflict?.key !== pending.conflict?.key) { setPendingAdd({ ...pending, conflict }); return; }
    if (!items.some(item => item.key === pending.entry.key) && !conflict && items.length >= MAX_ITEMS) { setError('提交列表最多可加入 50 个文件，请先提交或移除部分文件。'); return; }
    setItems(current => putQueueEntry(current, pending.entry, pending.conflict?.key));
    leaveEditor();
    if (day && problem) onClose();
  }
  async function checkEntry() {
    if (!editor || busy || operationBusy.current) return;
    let entry: Entry;
    try { entry = normalizeQueueEntry(editor); }
    catch (reason) { setError(errorText(reason)); return; }
    const path = submissionPath(entry.input);
    const conflict = findQueueConflict(items, entry);
    operationBusy.current = true; setInspectBusy(true); setError(''); setPendingAdd(null);
    let exists: boolean | null = null;
    try {
      const inspection = await api.inspectSubmissionFile(entry.input);
      if (!mounted.current) return;
      if (inspection.path !== path) throw new Error('文件检查结果与当前路径不一致，请重新检查。');
      exists = inspection.exists;
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { operationBusy.current = false; if (mounted.current) setInspectBusy(false); }
    if (!mounted.current) return;
    const pending = { entry, path, exists, conflict };
    if (exists === false && !conflict) commitEntry(pending);
    else setPendingAdd(pending);
  }
  function input(forSubmit = false): BatchSubmissionInput {
    return { items: items.map(item => item.input), notes, target: { kind: 'new' }, requestId, ...(forSubmit && overwriteFiles.length ? { overwrites: overwriteFiles.map(file => ({ path: file.path, sha: file.previous!.sha })) } : {}) };
  }
  function submissionError(reason: unknown) {
    if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'submission_base_changed') {
      onResetRequestId(); setPreview(null); setConfirmedOverwrites(new Set());
    }
    setError(errorText(reason));
  }
  async function prepare() {
    if (!canPreview || locked || operationBusy.current || !api.isDesktop) return;
    if (!auth.user) { onLogin(); return; }
    if (!settings.forkRepository) { setForkSetupOpen(true); return; }
    const login = auth.user.login;
    operationBusy.current = true; setPreviewBusy(true); setError(''); setConfirmedOverwrites(new Set());
    try {
      const next = await api.previewBatchSubmission(input());
      if (!mounted.current) return;
      if (account.current !== login) { setError('GitHub 账号已变化，请重新预览。'); return; }
      previewLogin.current = login; setPreview(next);
    } catch (reason) { if (mounted.current) submissionError(reason); }
    finally { operationBusy.current = false; if (mounted.current) setPreviewBusy(false); }
  }
  async function submit() {
    if (!preview || busy || operationBusy.current || !canSubmit) return;
    if (previewLogin.current !== account.current) { setPreview(null); setError('GitHub 账号已变化，请重新预览。'); return; }
    operationBusy.current = true; setSubmitBusy(true); setError(''); setProgress({ stage: 'validating', message: '正在检查代码与仓库路径…' });
    try { const result = await api.submitBatch(input(true)); if (mounted.current) onSubmitted(result); }
    catch (reason) { if (mounted.current) submissionError(reason); }
    finally { operationBusy.current = false; if (mounted.current) setSubmitBusy(false); }
  }

  const closeConfirmation = closeRequested && <Modal title={t('放弃本次编辑？')} subtitle={t('尚未加入列表的修改会丢失，提交列表中的文件会保留。')} onClose={cancelClose}><div className="confirm-actions"><button className="button button-secondary" type="button" onClick={cancelClose}>{t('继续编辑')}</button><button className="button button-primary" type="button" onClick={confirmClose}>{t('放弃修改')}</button></div></Modal>;
  const errorPanel = error && <div className="alert alert-error" role="alert"><CircleHelp size={17} /><span>{t(error)}</span></div>;

  if (forkSetupOpen) return <><Modal title={t('选择 Fork 仓库')} subtitle={t('选择或创建个人 Fork，确认后继续提交。')} onClose={() => { if (!forkWorkingRef.current && !forkSavingRef.current) setForkSetupOpen(false); }} closable={!forkSaving && !forkWorking} wide>
    {!auth.user && <div className="fork-gate-login"><p>{t('登录 GitHub 后选择提交使用的 Fork。')}</p><button className="button button-primary" type="button" onClick={onLogin} disabled={!api.isDesktop}>{t('登录 GitHub')}</button></div>}
    <fieldset className="batch-fields fork-gate-fields" disabled={forkSaving}><ForkSettings auth={auth} repository={repository} value={forkCandidate} onChange={value => { setForkCandidate(value); setForkError(''); }} onBusyChange={onForkBusyChange} /></fieldset>
    {forkError && <div className="alert alert-error" role="alert">{t(forkError)}</div>}
    <div className="confirm-actions"><button className="button button-secondary" type="button" disabled={forkSaving || forkWorking} onClick={() => setForkSetupOpen(false)}>{t('返回列表')}</button><button className="button button-primary" type="button" disabled={!forkCandidate || !auth.user || forkSaving || forkWorking || !api.isDesktop} onClick={() => void bindFork()}>{forkSaving ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}{forkSaving ? t('正在验证…') : t('使用这个 Fork')}</button></div>
  </Modal>{closeConfirmation}</>;

  if (editor) {
    const filename = filenamePreview(editor.input);
    const entryName = t('{{value1}} · {{value2}} · 第 {{value3}} 份', { value1: editor.input.problemId.toUpperCase(), value2: editor.input.date, value3: editor.ordinal });
    const filenameId = `filename-${editor.key}`;
    const extensionErrorId = `extension-error-${editor.key}`;
    const extension = editor.input.extension ?? submissionExtension(editor.input);
    const fileFormat = fileFormatLabel(editor.input);
    return <><Modal title={editorOriginal ? t('编辑提交文件') : t('加入提交列表')} subtitle={`${editor.input.problemId.toUpperCase()} · ${editor.input.date}`} onClose={() => requestClose()} wide closable={!busy}>
      <div className="composer-form queue-editor">
        <fieldset className="batch-fields" disabled={busy || Boolean(pendingAdd)}>
          {renderMetadata(editor.problem)}
          <ProblemContributionStatus problemId={editor.input.problemId} records={records} incomplete={statusIncomplete} warning onOpen={url => void api.openExternal(url).catch(reason => setError(errorText(reason)))} />
          <div className="composer-fields">
            <label className="field"><span>{t('编程语言')}</span><select aria-label={t('编程语言 {{value1}}', { value1: entryName })} value={editor.input.language} onChange={event => chooseLanguage(event.target.value)}>{LANGUAGES.map(language => <option key={language.id} value={language.id}>{language.id === 'other' ? t('其他') : `${language.label} (.${language.extension})`}</option>)}</select></label>
            <label className="field"><span>{t('扩展名')} <span className="required">*</span></span><input aria-label={t('扩展名 {{value1}}', { value1: entryName })} value={extension} aria-invalid={Boolean(filename.extensionError)} aria-describedby={filename.extensionError ? extensionErrorId : undefined} onChange={event => changeExtension(event.target.value)} placeholder="cpp" autoComplete="off" spellCheck={false} />{filename.extensionError && <small id={extensionErrorId} className="submission-filename is-error" aria-live="polite">{t(filename.extensionError)}</small>}</label>
            <label className="field submission-author-field"><span>{t('署名')} <span className="required">*</span></span><input aria-label={t('署名 {{value1}}', { value1: entryName })} value={editor.input.author} aria-invalid={Boolean(filename.authorError)} aria-describedby={filenameId} onChange={event => updateEditor({ author: event.target.value })} placeholder={t('英文字母、数字、下划线或连字符')} autoComplete="off" maxLength={39} /><small id={filenameId} className={`submission-filename ${filename.authorError || filename.error ? 'is-error' : ''}`} aria-live="polite">{((filename.authorError || filename.error) && t(filename.authorError || filename.error)) || (filename.name ? <>{t('文件名：')}<code>{filename.name}</code></> : !editor.input.author.trim() ? t('填写署名后显示文件名') : null)}</small></label>
          </div>
          <div className="file-upload-section">{editor.fileName ? <><div className="uploaded-file"><span className="file-icon"><FileCode2 size={21} /></span><div><strong title={editor.fileName}>{editor.fileName}</strong><small>{t('{{bytes}} 字节 · {{language}}', { bytes: new TextEncoder().encode(editor.input.code).byteLength.toLocaleString(locale), language: fileFormat })}</small></div><button className="button button-secondary" type="button" onClick={() => void importCode()} disabled={!api.isDesktop}><Upload size={15} />{t('重新选择文件')}</button></div><details className="batch-code-disclosure" open><summary><span>{t('代码预览')}</span><small>{t('只读')}</small><ChevronDown size={14} /></summary><CodeHighlight code={editor.input.code} language={fileFormat} className="uploaded-code-preview" /></details></> : <div className="batch-upload-empty"><FileCode2 size={23} /><span>{importBusy ? t('正在选择文件…') : t('尚未选择代码文件')}</span><button className="button button-primary" type="button" onClick={() => void importCode()} disabled={!api.isDesktop}>{importBusy ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}{t('选择代码文件')}</button></div>}</div>
        </fieldset>
        {pendingAdd && <section className="queue-add-confirmation" aria-label={t('确认加入列表')}>
          {pendingAdd.conflict && <div className="alert alert-warning"><CircleHelp size={18} /><div><strong>{t('提交列表中已有同路径文件')}</strong><p>{t('继续会替换列表中的这份代码，其他文件不受影响。')}</p><CodeDiff context="queue" previous={pendingAdd.conflict.input.code} next={pendingAdd.entry.input.code} language={fileFormatLabel(pendingAdd.entry.input)} /></div></div>}
          {pendingAdd.exists === true && <div className="alert alert-warning"><CircleHelp size={18} /><div><strong>{t('仓库中已有这个文件')}</strong><p>{t('仍可加入列表。生成 PR 前会展示现有代码与本次代码的差异，修改已有文件需要再次确认。')}</p></div></div>}
          {pendingAdd.exists === null && <div className="alert alert-warning"><CircleHelp size={18} /><div><strong>{t('暂时无法检查仓库中的文件')}</strong><p>{t('可以先加入列表，生成 PR 前会重新检查。')}</p></div></div>}
          <p className="path-preview">{pendingAdd.path}</p>
        </section>}
        {errorPanel}
        <div className="composer-footer"><span>{t('列表中已有 {{count}} 个文件', { count: items.length })}</span><div>
          {pendingAdd ? <><button className="button button-secondary" type="button" onClick={() => { setPendingAdd(null); setError(''); }}>{t('返回调整')}</button>{pendingAdd.exists === null && <button className="button button-secondary" type="button" onClick={() => void checkEntry()}>{t('重新检查')}</button>}<button className="button button-primary" type="button" onClick={() => commitEntry(pendingAdd)}>{pendingAdd.conflict ? t('替换列表中的文件') : t('仍然加入列表')}</button></> : <><button className="button button-secondary" type="button" disabled={busy} onClick={() => requestClose(day && problem ? onClose : leaveEditor)}>{day && problem ? t('取消') : t('返回列表')}</button><button className="button button-primary" type="button" disabled={busy || !editor.fileName || !editor.input.code.trim() || !filename.name || !api.isDesktop} onClick={() => void checkEntry()}>{inspectBusy ? <LoaderCircle size={16} className="spin" /> : <ListPlus size={16} />}{inspectBusy ? t('正在检查…') : editorOriginal ? t('保存到列表') : t('加入列表')}</button></>}
        </div></div>
      </div>
    </Modal>{closeConfirmation}</>;
  }

  return <><Modal title={t('提交列表')} subtitle={t('{{value1}} 道题目 · {{value2}} 份解答 · {{value3}} 个代码文件', { value1: problemCount, value2: items.length, value3: items.length })} onClose={() => requestClose()} wide closable={!busy}>
    <div className="composer-form batch-composer">
      <fieldset className="batch-fields" disabled={locked}>
        <p className="queue-intro">{t('列表中的文件将一起创建一个新的 PR。')}</p>
        {settings.forkRepository && <div className="batch-fork-binding"><span><strong>{settings.forkRepository}</strong><span> → {repository}</span></span><button className="text-button" type="button" onClick={() => { setForkCandidate(''); setForkSetupOpen(true); }}>{t('更换 Fork')}</button></div>}
        {auth.user && statusIncomplete && <p className="batch-status-incomplete"><CircleHelp size={14} />{t('状态未完整获取，未显示关联 PR 的题目仍可能有提交记录。')}</p>}
        <div className="queue-items">
          {items.map((item, index) => <section className="queue-item" key={item.key} role="group" aria-label={t('提交文件 {{name}}', { name: submissionFileName(item.input) })}>
            <div className="queue-item-heading"><span className="batch-item-number">{String(index + 1).padStart(2, '0')}</span><div className="queue-item-identity"><strong>{item.input.problemId.toUpperCase()}</strong><time>{item.input.date}</time><span>{fileFormatLabel(item.input)} · {item.input.author}</span></div><div className="queue-item-actions"><button className="text-button" type="button" onClick={() => editItem(item)} aria-label={t('编辑 {{name}}', { name: submissionFileName(item.input) })}><Pencil size={14} />{t('编辑')}</button><button className="icon-button" type="button" aria-label={t('移除 {{value1}}', { value1: submissionFileName(item.input) })} onClick={() => { setItems(current => current.filter(entry => entry.key !== item.key)); setError(''); }}><Trash2 size={16} /></button></div></div>
            <p className="queue-file-path">{submissionPath(item.input)}</p>
            {item.unavailable && <p className="inline-error">{t('当前仓库题单中未找到这道题，请重新核对题号和日期。')}</p>}
            <ProblemContributionStatus problemId={item.input.problemId} records={records} incomplete={statusIncomplete} warning onOpen={url => void api.openExternal(url).catch(reason => setError(errorText(reason)))} />
            <details className="batch-code-disclosure"><summary><span>{t('代码预览')}</span><small>{item.fileName}</small><ChevronDown size={14} /></summary><CodeHighlight code={item.input.code} language={fileFormatLabel(item.input)} className="uploaded-code-preview" /></details>
          </section>)}
          {!items.length && <div className="queue-empty"><ListPlus size={30} /><strong>{t('提交列表为空')}</strong><p>{t('从题目页面加入代码文件，或在下方选择题目。')}</p></div>}
        </div>
        <section className="batch-add-panel" aria-label={t('添加更多题目')} aria-busy={dayBusy}>
          <div className="batch-add-heading"><h3><Plus size={17} />{t('添加题目')}</h3><span>{items.length} / {MAX_ITEMS}</span></div>
          <div className="batch-date-picker"><label><CalendarDays size={16} /><input type="date" aria-label={t('添加题目日期')} aria-describedby={pickerStatusId} aria-invalid={Boolean(pickerDate && !validPickerDate)} value={pickerDate} onInput={event => picker.select(event.currentTarget.value)} onChange={event => picker.select(event.target.value)} /></label><button className="button button-secondary" type="button" disabled={dayBusy || (!validPickerDate && picker.status !== 'error')} onClick={picker.refresh}>{dayBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{dayBusy ? t('正在读取…') : dayError ? t('重试') : t('刷新题目')}</button></div>
          <p id={pickerStatusId} className="batch-picker-caption" role="status" aria-live="polite">{dayBusy ? pickerDate ? t('正在读取 {{date}} 的题目…', { date: pickerDate }) : t('正在读取最新题目…') : dayError ? pickerDate ? t('未能读取 {{date}} 的题目。', { date: pickerDate }) : t('未能读取最新题目。') : pickerDay ? t('{{value1}} · {{value2}} 道题目', { value1: pickerDay.date, value2: pickerDay.problems.length }) : pickerDate && !validPickerDate ? t('请输入完整、有效的日期。') : t('选择日期后会自动读取题目。')}</p>
          {dayError && <p className="inline-error" role="alert">{t(dayError)}</p>}
          <div className="batch-problem-options">{(pickerDay?.problems || []).map(candidate => { const copies = items.filter(item => problemKey(item.input.date, item.problem) === problemKey(pickerDay!.date, candidate)).length; return <button key={candidate.id} type="button" className={copies ? 'added' : ''} disabled={items.length >= MAX_ITEMS || dayBusy} aria-label={t('添加 {{value1}}', { value1: candidate.id.toUpperCase() })} onClick={() => addItem(candidate)}><Plus size={14} /><span>{candidate.id.toUpperCase()}{copies > 0 && <small>{t('已添加 {{count}} 份', { count: copies })}</small>}</span></button>; })}{pickerDay && !pickerDay.problems.length && <span>{t('这一天没有找到题目，可选择其他日期。')}</span>}</div>
        </section>
        <label className="field notes-field"><span>{t('补充说明')} <small>{t('可选 · 写入本次 PR 描述')}</small></span><textarea aria-label={t('本次 PR 补充说明')} value={notes} onChange={event => { setNotes(event.target.value); setError(''); }} placeholder={t('可填写解题思路或其他说明。')} rows={2} maxLength={2000} /></label>
      </fieldset>
      {errorPanel}
      {preview && <QueuePreview preview={preview} repository={repository} login={auth.user?.login || ''} records={records} statusIncomplete={statusIncomplete} normalizedInputs={normalizedInputs} confirmedOverwrites={confirmedOverwrites} onConfirmedOverwritesChange={setConfirmedOverwrites} submitBusy={submitBusy} onError={setError} />}
      {submitBusy && <div className="submission-progress batch-current-progress" aria-live="polite"><LoaderCircle size={18} className="spin" /><p>{(progress?.message && t(progress.message)) || t('正在提交，请保持客户端开启…')}</p></div>}
      {preview && !allOverwritesConfirmed && <p className="overwrite-pending" role="status">{t('请先逐项确认需要覆盖的文件。')}</p>}
      <div className="composer-footer"><span>{t('{{count}} 个文件 · {{bytes}} 字节', { count: items.length, bytes: totalBytes.toLocaleString(locale) })}<br />{t('关闭列表后仍会保留，退出程序后清除。')}</span><div>{preview && <button className="button button-secondary" type="button" disabled={submitBusy} onClick={() => { setPreview(null); setConfirmedOverwrites(new Set()); setError(''); }}>{t('返回调整')}</button>}<button className="button button-secondary" type="button" disabled={busy} onClick={() => requestClose()}>{t('关闭')}</button>{preview ? <button className="button button-primary" type="button" disabled={submitBusy || !canSubmit} onClick={() => void submit()}>{submitBusy ? <LoaderCircle size={16} className="spin" /> : <GitPullRequest size={16} />}{submitBusy ? t('正在提交…') : t('提交 PR')}</button> : <button className="button button-primary" type="button" disabled={busy || !canPreview || !api.isDesktop} onClick={() => void prepare()}>{previewBusy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}{previewBusy ? t('正在检查…') : auth.user ? t('预览 PR') : t('登录后提交')}</button>}</div></div>
    </div>
  </Modal>{closeConfirmation}</>;
}
