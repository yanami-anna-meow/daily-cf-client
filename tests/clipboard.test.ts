import { describe, expect, it, vi } from 'vitest';
import { clipboardText, MAX_CLIPBOARD_BYTES } from '../shared/clipboard';
import { copyBrowserText } from '../src/browser-clipboard';

/** A deliberately small DOM fake: clipboard fallback must not need a browser framework. */
function fakeDocument() {
  const children: unknown[] = [];
  const savedRange = { startOffset: 2, endOffset: 7 } as Range;
  const originalRange = { cloneRange: vi.fn(() => savedRange) } as unknown as Range;
  let ranges: Range[] = [originalRange];
  let activeElement: unknown;
  const selection = {
    get rangeCount() { return ranges.length; },
    getRangeAt: vi.fn((index: number) => ranges[index]),
    removeAllRanges: vi.fn(() => { ranges = []; }),
    addRange: vi.fn((range: Range) => { ranges.push(range); }),
  };
  const previousElement = {
    tagName: 'INPUT', selectionStart: 3, selectionEnd: 8, selectionDirection: 'backward',
    closest: vi.fn((_selector: string): HTMLElement | null => null),
    focus: vi.fn(() => { activeElement = previousElement; }),
    setSelectionRange: vi.fn(),
  };
  activeElement = previousElement;
  const body = {
    appendChild: vi.fn((child: unknown) => { children.push(child); return child; }),
    removeChild: vi.fn((child: unknown) => {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      return child;
    }),
  };
  const textarea = {
    value: '', style: {}, readOnly: false, tabIndex: 0, selectionStart: 0, selectionEnd: 0,
    setAttribute: vi.fn(),
    focus: vi.fn(() => { activeElement = textarea; }),
    select: vi.fn(() => { ranges = [{} as Range]; }),
    setSelectionRange: vi.fn((start: number, end: number) => { textarea.selectionStart = start; textarea.selectionEnd = end; }),
    remove: vi.fn(() => { textarea.parentNode.removeChild(textarea); }),
    parentNode: body,
  };
  const document = {
    body,
    get activeElement() { return activeElement; },
    createElement: vi.fn((tag: string) => {
      if (tag !== 'textarea') throw new Error(`Unexpected element: ${tag}`);
      return textarea;
    }),
    getSelection: vi.fn(() => selection),
    querySelectorAll: vi.fn((_selector: string): HTMLElement[] => []),
    defaultView: { getSelection: vi.fn(() => selection) },
    execCommand: vi.fn(() => true),
  };
  return {
    document: document as unknown as Document,
    raw: document,
    body, textarea, selection, previousElement, savedRange, children,
    currentRanges: () => ranges,
    setActiveElement: (value: unknown) => { activeElement = value; },
  };
}

describe('clipboard text boundary', () => {
  it('uses a one MiB UTF-8 limit', () => {
    expect(MAX_CLIPBOARD_BYTES).toBe(1024 * 1024);
  });

  it.each([
    ['undefined', undefined], ['null', null], ['number', 123], ['boolean', false],
    ['object', {}], ['array', ['code']], ['boxed string', new String('code')],
  ])('rejects %s without coercing it', (_name, value) => {
    expect(() => clipboardText(value)).toThrow();
  });

  it.each(['', '  line one\r\nline two\n', '中文代码：你好 🌍', '\t\n'])('preserves valid text exactly', value => {
    expect(clipboardText(value)).toBe(value);
  });

  it.each(['\0', 'before\0after', 'trailing\0'])('rejects embedded NUL characters', value => {
    expect(() => clipboardText(value)).toThrow();
  });

  it('allows exactly the maximum number of ASCII bytes and rejects one more', () => {
    const text = 'a'.repeat(MAX_CLIPBOARD_BYTES);
    expect(clipboardText(text)).toBe(text);
    expect(() => clipboardText(text + 'a')).toThrow();
  });

  it('counts UTF-8 bytes for Chinese text, including a mixed boundary', () => {
    const text = '中'.repeat(Math.floor(MAX_CLIPBOARD_BYTES / 3)) + 'a';
    expect(new TextEncoder().encode(text).byteLength).toBe(MAX_CLIPBOARD_BYTES);
    expect(clipboardText(text)).toBe(text);
    expect(() => clipboardText(text + 'a')).toThrow();
  });

  it('counts supplementary Unicode code points as four bytes', () => {
    const text = '😀'.repeat(MAX_CLIPBOARD_BYTES / 4);
    expect(clipboardText(text)).toBe(text);
    expect(() => clipboardText(text + '😀')).toThrow();
  });
});

describe('browser clipboard', () => {
  it('uses the modern clipboard API without reading or modifying the DOM', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    const document = new Proxy({}, {
      get() { throw new Error('The successful modern path must not access the DOM.'); },
    }) as Document;
    await expect(copyBrowserText('  中文\r\n', { clipboard: { writeText }, document })).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('  中文\r\n');
  });

  it('waits for the modern API before reporting completion', async () => {
    let finish!: () => void;
    let resolved = false;
    const writeText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const copying = copyBrowserText('code', { clipboard: { writeText } }).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    finish();
    await copying;
    expect(resolved).toBe(true);
  });

  it('keeps the clipboard API receiver bound', async () => {
    const clipboard = {
      writeText: vi.fn(async function (this: unknown, _text: string) {
        expect(this).toBe(clipboard);
      }),
    };
    await expect(copyBrowserText('code', { clipboard })).resolves.toBeUndefined();
  });

  it.each([
    ['invalid type', {}], ['NUL', 'a\0b'], ['oversized UTF-8', '中'.repeat(MAX_CLIPBOARD_BYTES / 2)],
  ])('validates %s before touching any clipboard or DOM API', async (_name, value) => {
    const writeText = vi.fn(async (_text: string) => {});
    const dom = fakeDocument();
    await expect(copyBrowserText(value, { clipboard: { writeText }, document: dom.document })).rejects.toThrow();
    expect(writeText).not.toHaveBeenCalled();
    expect(dom.raw.createElement).not.toHaveBeenCalled();
    expect(dom.raw.execCommand).not.toHaveBeenCalled();
  });

  it('copies using a temporary selected textarea when the modern API is absent', async () => {
    const dom = fakeDocument();
    const value = '  #include <bits/stdc++.h>\r\n// 中文 😀\n';
    dom.raw.execCommand.mockImplementation(() => {
      expect(dom.children).toEqual([dom.textarea]);
      expect(dom.textarea.value).toBe(value);
      expect(dom.textarea.select).toHaveBeenCalledOnce();
      return true;
    });
    await expect(copyBrowserText(value, { document: dom.document })).resolves.toBeUndefined();
    expect(dom.raw.execCommand).toHaveBeenCalledWith('copy');
    expect(dom.children).toEqual([]);
    expect(dom.previousElement.focus).toHaveBeenCalledOnce();
    expect(dom.previousElement.setSelectionRange).toHaveBeenCalledExactlyOnceWith(3, 8, 'backward');
  });

  it('falls back after the modern API rejects permission', async () => {
    const dom = fakeDocument();
    const writeText = vi.fn(async (_text: string) => { throw new Error('Permission denied'); });
    await expect(copyBrowserText('code', { clipboard: { writeText }, document: dom.document })).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('code');
    expect(dom.raw.execCommand).toHaveBeenCalledExactlyOnceWith('copy');
    expect(dom.children).toEqual([]);
  });

  it('keeps fallback copying inside the active dialog so its focus trap cannot redirect the selection', async () => {
    const dom = fakeDocument();
    const modalChildren: unknown[] = [];
    const dialog = {
      appendChild: vi.fn((child: unknown) => { modalChildren.push(child); dom.textarea.parentNode = dialog; return child; }),
      removeChild: vi.fn((child: unknown) => { modalChildren.splice(modalChildren.indexOf(child), 1); return child; }),
    };
    dom.previousElement.closest.mockReturnValue(dialog as unknown as HTMLElement);
    dom.textarea.focus.mockImplementation(() => {
      // Reproduce Modal's focusin trap: only descendants can retain focus.
      dom.setActiveElement(dom.textarea.parentNode === dialog ? dom.textarea : dom.previousElement);
    });
    dom.raw.execCommand.mockImplementation(() => {
      expect(dom.raw.activeElement).toBe(dom.textarea);
      expect(dom.textarea.value).toBe('ABCD-1234');
      expect(dom.textarea.selectionEnd).toBe(9);
      return true;
    });
    const writeText = vi.fn(async () => { throw new Error('Permission denied'); });
    await expect(copyBrowserText('ABCD-1234', { clipboard: { writeText }, document: dom.document })).resolves.toBeUndefined();
    expect(dom.previousElement.closest).toHaveBeenCalledWith('[role="dialog"]');
    expect(dom.body.appendChild).not.toHaveBeenCalled();
    expect(dialog.appendChild).toHaveBeenCalledExactlyOnceWith(dom.textarea);
    expect(modalChildren).toEqual([]);
    expect(dom.previousElement.focus).toHaveBeenCalledOnce();
  });

  it('uses the topmost visible modal when the current focus has no dialog ancestor', async () => {
    const dom = fakeDocument();
    const dialog = (visible: boolean) => ({
      getClientRects: () => visible ? [{}] : [], getAttribute: () => null, hasAttribute: () => false,
      appendChild: vi.fn((child: unknown) => { dom.textarea.parentNode = modal; return child; }),
      removeChild: vi.fn((child: unknown) => child),
    });
    const lower = dialog(true);
    const modal = dialog(true);
    const hidden = dialog(false);
    dom.raw.querySelectorAll.mockReturnValue([lower, modal, hidden] as unknown as HTMLElement[]);
    await expect(copyBrowserText('code', { document: dom.document })).resolves.toBeUndefined();
    expect(modal.appendChild).toHaveBeenCalledExactlyOnceWith(dom.textarea);
    expect(lower.appendChild).not.toHaveBeenCalled();
    expect(hidden.appendChild).not.toHaveBeenCalled();
    expect(dom.body.appendChild).not.toHaveBeenCalled();
  });

  it('rejects instead of copying another element when a focus trap still steals focus', async () => {
    const dom = fakeDocument();
    dom.textarea.focus.mockImplementation(() => { dom.setActiveElement(dom.previousElement); });
    await expect(copyBrowserText('code', { document: dom.document })).rejects.toThrow('复制失败');
    expect(dom.raw.execCommand).not.toHaveBeenCalled();
    expect(dom.children).toEqual([]);
  });

  it('rejects before execCommand when the requested text selection could not be established', async () => {
    const dom = fakeDocument();
    dom.textarea.setSelectionRange.mockImplementation(() => {});
    await expect(copyBrowserText('code', { document: dom.document })).rejects.toThrow('复制失败');
    expect(dom.raw.execCommand).not.toHaveBeenCalled();
    expect(dom.children).toEqual([]);
  });

  it('also falls back if the modern API throws synchronously', async () => {
    const dom = fakeDocument();
    const writeText = vi.fn((_text: string): Promise<void> => { throw new Error('API unavailable'); });
    await expect(copyBrowserText('code', { clipboard: { writeText }, document: dom.document })).resolves.toBeUndefined();
    expect(dom.raw.execCommand).toHaveBeenCalledOnce();
  });

  it.each(['false', 'throw'] as const)('rejects and restores DOM state when execCommand returns %s', async outcome => {
    const dom = fakeDocument();
    dom.raw.execCommand.mockImplementation(() => {
      if (outcome === 'throw') throw new Error('copy not supported');
      return false;
    });
    await expect(copyBrowserText('code', { document: dom.document })).rejects.toThrow();
    expect(dom.children).toEqual([]);
    expect(dom.previousElement.focus).toHaveBeenCalledOnce();
    expect(dom.previousElement.setSelectionRange).toHaveBeenCalledExactlyOnceWith(3, 8, 'backward');
  });

  it.each([true, false])('restores the page selection when the previous focus is not a text input (copy: %s)', async copied => {
    const dom = fakeDocument();
    Object.defineProperty(dom.previousElement, 'selectionStart', { value: undefined });
    Object.defineProperty(dom.previousElement, 'selectionEnd', { value: undefined });
    dom.raw.execCommand.mockReturnValue(copied);
    const operation = copyBrowserText('code', { document: dom.document });
    if (copied) await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toThrow();
    expect(dom.children).toEqual([]);
    expect(dom.previousElement.focus).toHaveBeenCalledOnce();
    expect(dom.selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(dom.selection.addRange).toHaveBeenCalledExactlyOnceWith(dom.savedRange);
    expect(dom.currentRanges()).toEqual([dom.savedRange]);
  });

  it('cleans up if selecting the temporary textarea fails', async () => {
    const dom = fakeDocument();
    dom.textarea.select.mockImplementation(() => { throw new Error('Selection unavailable'); });
    await expect(copyBrowserText('code', { document: dom.document })).rejects.toThrow();
    expect(dom.raw.execCommand).not.toHaveBeenCalled();
    expect(dom.children).toEqual([]);
    expect(dom.previousElement.focus).toHaveBeenCalledOnce();
    expect(dom.previousElement.setSelectionRange).toHaveBeenCalledExactlyOnceWith(3, 8, 'backward');
  });

  it('retains successful copy status if the former focus was removed during copying', async () => {
    const dom = fakeDocument();
    dom.previousElement.focus.mockImplementation(() => { throw new Error('Element detached'); });
    dom.previousElement.setSelectionRange.mockImplementation(() => { throw new Error('Element detached'); });
    await expect(copyBrowserText('code', { document: dom.document })).resolves.toBeUndefined();
    expect(dom.children).toEqual([]);
  });

  it('works when the document has no previous focus or text selection', async () => {
    const dom = fakeDocument();
    dom.setActiveElement(null);
    Object.defineProperty(dom.raw, 'getSelection', { value: () => null });
    await expect(copyBrowserText('code', { document: dom.document })).resolves.toBeUndefined();
    expect(dom.children).toEqual([]);
  });

  it('rejects when neither browser clipboard mechanism exists', async () => {
    await expect(copyBrowserText('code', {})).rejects.toThrow();
  });

  it('rejects when fallback execCommand is missing', async () => {
    const dom = fakeDocument();
    Object.defineProperty(dom.raw, 'execCommand', { value: undefined });
    await expect(copyBrowserText('code', { document: dom.document })).rejects.toThrow();
    expect(dom.children).toEqual([]);
  });

  it('rejects when fallback has no document body', async () => {
    const dom = fakeDocument();
    Object.defineProperty(dom.raw, 'body', { value: null });
    await expect(copyBrowserText('code', { document: dom.document })).rejects.toThrow();
    expect(dom.raw.execCommand).not.toHaveBeenCalled();
  });

  it('does not report success when both modern and fallback mechanisms fail', async () => {
    const dom = fakeDocument();
    const writeText = vi.fn(async (_text: string) => { throw new Error('Permission denied'); });
    dom.raw.execCommand.mockReturnValue(false);
    await expect(copyBrowserText('code', { clipboard: { writeText }, document: dom.document })).rejects.toThrow();
    expect(writeText).toHaveBeenCalledOnce();
    expect(dom.raw.execCommand).toHaveBeenCalledOnce();
    expect(dom.children).toEqual([]);
  });

  it('returns an actionable copy error when permission is denied and fallback is unavailable', async () => {
    const writeText = vi.fn(async (_text: string) => { throw new Error('Internal browser permission detail'); });
    await expect(copyBrowserText('code', { clipboard: { writeText } })).rejects.toThrow(/复制失败.*Ctrl\+C/);
  });

  it('permits an empty clipboard value', async () => {
    const dom = fakeDocument();
    await expect(copyBrowserText('', { document: dom.document })).resolves.toBeUndefined();
    expect(dom.textarea.value).toBe('');
    expect(dom.raw.execCommand).toHaveBeenCalledOnce();
  });
});
