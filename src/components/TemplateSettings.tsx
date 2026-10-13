import { useRef, useState } from 'react';
import { Braces, ChevronDown, FilePenLine, RotateCcw } from 'lucide-react';
import { getDefaultPRBodyTemplate, getDefaultPRTitleTemplate, TEMPLATE_VARIABLES, renderPRTemplates } from '../../shared/templates';
import type { Problem, Settings, SubmissionInput } from '../../shared/types';
import Markdown from './Markdown';
import { t } from '../../shared/i18n';

interface TemplateSettingsProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  input: SubmissionInput;
  login: string;
  problem?: Problem;
}

export default function TemplateSettings({ settings, onChange, input, login, problem }: TemplateSettingsProps) {
  const [activeField, setActiveField] = useState<'title' | 'body'>('body');
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const defaultTitle = getDefaultPRTitleTemplate();
  const defaultBody = getDefaultPRBodyTemplate();
  const title = settings.prTitleTemplate ?? defaultTitle;
  const body = settings.prBodyTemplate ?? defaultBody;
  let preview: { title: string; body: string } | null = null;
  let previewError = '';
  try { preview = renderPRTemplates(input, { login, problem }, { title, body }); }
  catch (error) { previewError = error instanceof Error ? error.message : String(error); }

  function changeTemplate(field: 'title' | 'body', value: string) {
    onChange(field === 'title' ? { prTitleTemplate: value } : { prBodyTemplate: value });
  }

  function insertVariable(name: string) {
    const element = activeField === 'title' ? titleRef.current : bodyRef.current;
    const value = activeField === 'title' ? title : body;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? start;
    const variable = `{{${name}}}`;
    const updated = value.slice(0, start) + variable + value.slice(end);
    changeTemplate(activeField, updated);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + variable.length, start + variable.length); });
  }

  return <section className="panel settings-section template-settings">
    <div className="settings-section-title"><h2><FilePenLine size={20} />{t('Pull Request 模板')}</h2><button className="text-button" onClick={() => onChange({ prTitleTemplate: undefined, prBodyTemplate: undefined })}><RotateCcw size={13} />{t('恢复默认')}</button></div>
    <p className="settings-description">{t('从提交列表创建 PR 时，使用此模板生成标题和描述。下方变量会替换为实际提交的题目信息。')}</p>
    <label className="field"><span>{t('PR 标题模板')}</span><input ref={titleRef} value={title} onFocus={() => setActiveField('title')} onChange={(event) => changeTemplate('title', event.target.value)} placeholder={defaultTitle} spellCheck={false} maxLength={1000} /><small>{t('标题须以所选题目中最早的日期开头，例如 {{variable}}。留空使用默认模板。', { variable: '{{date_compact}}' })}</small></label>
    <label className="field template-body-field"><span>{t('PR 描述模板')} <small>{t('支持 Markdown')}</small></span><textarea ref={bodyRef} rows={7} value={body} onFocus={() => setActiveField('body')} onChange={(event) => changeTemplate('body', event.target.value)} placeholder={defaultBody} spellCheck={false} maxLength={12000} /></label>
    <details className="template-variables" open><summary><Braces size={14} /><span>{t('插入变量')}</span><small>{activeField === 'title' ? t('点击插入标题光标处') : t('点击插入描述光标处')}</small><ChevronDown size={13} /></summary><div>{TEMPLATE_VARIABLES.map((variable) => <button key={variable.name} title={t('{{label}} · 示例：{{example}}', { label: t(variable.label), example: t(variable.example) })} onClick={() => insertVariable(variable.name)}><code>{`{{${variable.name}}}`}</code><span>{t(variable.label)}</span></button>)}</div></details>
    <div className="template-preview"><div className="template-preview-heading"><span>{t('实时预览')}</span><small>{t('示例：{{date}} · {{problem}} · 署名 {{author}}', { date: input.date, problem: input.problemId.toUpperCase(), author: input.author })}</small></div>{previewError ? <div className="inline-error" role="status">{previewError}</div> : preview && <><h3>{preview.title}</h3><div className="template-preview-body"><Markdown content={preview.body} /></div></>}</div>
  </section>;
}
