import { forwardRef, useMemo, type ReactNode } from 'react';
import type { RootContent } from 'hast';
import { common, createLowlight } from 'lowlight';
import scala from 'highlight.js/lib/languages/scala';
import delphi from 'highlight.js/lib/languages/delphi';
import d from 'highlight.js/lib/languages/d';
import haskell from 'highlight.js/lib/languages/haskell';
import ocaml from 'highlight.js/lib/languages/ocaml';
import fsharp from 'highlight.js/lib/languages/fsharp';

// Add only the repository languages missing from the common grammar set.
const lowlight = createLowlight({ ...common, scala, delphi, d, haskell, ocaml, fsharp });
const MAX_HIGHLIGHT_BYTES = 128 * 1024;

const languageAliases: Record<string, string> = {
  'c++': 'cpp', 'c / c++': 'cpp', 'c/c++': 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp',
  py: 'python', py3: 'python', python3: 'python', pypy: 'python', pypy3: 'python',
  rs: 'rust', cs: 'csharp', 'c#': 'csharp',
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  kt: 'kotlin', kts: 'kotlin', golang: 'go',
  pascal: 'delphi', pas: 'delphi', hs: 'haskell', ml: 'ocaml',
  'f#': 'fsharp', fs: 'fsharp', rb: 'ruby', pl: 'perl',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext', '文本': 'plaintext',
};

export function normalizeCodeLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const label = language.trim().toLowerCase().replace(/^language-/, '').replace(/^\./, '');
  const normalized = (Object.hasOwn(languageAliases, label) ? languageAliases[label] : undefined)
    ?? (/^(?:gnu\s*)?c\+\+\d*(?:\s.*)?$/.test(label) ? 'cpp' : undefined)
    ?? (/^(?:python|pypy)\s*3(?:\.\d+)*$/.test(label) ? 'python' : undefined)
    ?? label;
  return lowlight.registered(normalized) ? normalized : undefined;
}

function renderTokens(nodes: RootContent[], keyPrefix = ''): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return null;
    const key = `${keyPrefix}${index}`;
    const classes = node.properties.className;
    // Only token classes and text are rendered; source code never becomes HTML.
    const className = Array.isArray(classes)
      ? classes.filter((value): value is string => typeof value === 'string').join(' ')
      : typeof classes === 'string' ? classes : undefined;
    return <span key={key} className={className}>{renderTokens(node.children, `${key}.`)}</span>;
  });
}

export interface CodeHighlightProps {
  code: string;
  language?: string;
  className?: string;
  'aria-hidden'?: boolean;
}

const CodeHighlight = forwardRef<HTMLPreElement, CodeHighlightProps>(function CodeHighlight(
  { code, language, className = '', 'aria-hidden': ariaHidden }, ref,
) {
  const content = useMemo(() => {
    const normalized = normalizeCodeLanguage(language);
    // Check length first so very large imports do not allocate an encoded copy.
    if (!normalized || normalized === 'plaintext' || code.length > MAX_HIGHLIGHT_BYTES
      || new TextEncoder().encode(code).byteLength > MAX_HIGHLIGHT_BYTES) return code;
    try {
      return renderTokens(lowlight.highlight(normalized, code).children);
    } catch {
      // Highlighting is decorative; malformed or unsupported input stays usable.
      return code;
    }
  }, [code, language]);

  return <pre ref={ref} className={`code-highlight ${className}`.trim()} aria-hidden={ariaHidden}><code>{content}</code></pre>;
});

export default CodeHighlight;
