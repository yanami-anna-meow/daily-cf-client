import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { api } from '../bridge';
import CodeHighlight from './CodeHighlight';
import { t } from '../../shared/i18n';

interface MarkdownProps { content: string; }

function externalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function ExternalLink({ href, title, children }: { href?: string; title?: string; children: ReactNode }) {
  const safe = externalUrl(href);
  const [error, setError] = useState(false);
  if (!safe) return <span>{children}</span>;
  return <>
    <a href={safe} title={title || safe} onClick={event => {
      event.preventDefault();
      setError(false);
      void api.openExternal(safe).catch(() => setError(true));
    }}>{children}</a>
    {error && <span className="markdown-link-error" role="status">{t('（无法打开链接）')}</span>}
  </>;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const attempt = useRef(0);
  const copying = useRef(false);
  useEffect(() => { ++attempt.current; copying.current = false; setCopyState('idle'); return () => { ++attempt.current; copying.current = false; }; }, [code]);
  async function copy() {
    if (copying.current) return;
    copying.current = true;
    const current = ++attempt.current;
    setCopyState('copying');
    try { await api.copyText(code); if (current === attempt.current) setCopyState('copied'); }
    catch { if (current === attempt.current) setCopyState('failed'); }
    finally { if (current === attempt.current) copying.current = false; }
  }
  return <div className="markdown-code-block">
    <div className="markdown-code-toolbar"><span>{language || t('代码')}</span><button type="button" disabled={copyState === 'copying'} onClick={() => void copy()}>{copyState === 'copied' ? t('已复制') : copyState === 'failed' ? t('复制失败，重试') : copyState === 'copying' ? t('复制中…') : t('复制代码')}</button></div>
    <CodeHighlight code={code} language={language} />
    {copyState === 'failed' ? <p className="markdown-copy-error" role="status">{t('复制失败，可选中上方代码手动复制，或点击重试。')}</p> : <span className="sr-only" role="status">{copyState === 'copied' ? t('代码已复制到剪贴板') : ''}</span>}
  </div>;
}

const components: Components = {
  a: ({ href, title, children }) => <ExternalLink href={href} title={title}>{children}</ExternalLink>,
  // Image links remain explicit: repository documents cannot silently load remote resources.
  img: ({ src, alt, title }) => <ExternalLink href={typeof src === 'string' ? src : undefined} title={title}>{t('图片：{{description}}', { description: alt || t('查看图片') })}</ExternalLink>,
  pre: ({ node, children }) => {
    const codeNode = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
    if (codeNode?.type !== 'element') return <pre>{children}</pre>;
    const classes = Array.isArray(codeNode.properties.className) ? codeNode.properties.className : [];
    const language = classes.find(name => typeof name === 'string' && name.startsWith('language-'))?.toString().slice(9) || '';
    const code = codeNode.children.map(child => child.type === 'text' ? child.value : '').join('');
    return <CodeBlock code={code} language={language} />;
  },
  table: ({ children }) => <div className="markdown-table-wrap"><table>{children}</table></div>,
  li: ({ className, children }) => <li className={className?.includes('task-list-item') ? `${className} markdown-task-item` : className}>{children}</li>,
  input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled aria-label={checked ? t('已完成') : t('未完成')} />,
};

export function Markdown({ content }: MarkdownProps) {
  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }]]}
      components={components}
      skipHtml
    >{content}</ReactMarkdown>
  </div>;
}

export default Markdown;
