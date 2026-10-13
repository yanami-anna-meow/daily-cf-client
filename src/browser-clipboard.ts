import { clipboardText } from '../shared/clipboard';
import { t } from '../shared/i18n';

export interface BrowserClipboardEnvironment {
  clipboard?: Pick<Clipboard, 'writeText'>;
  document?: Document;
}

function copyFailure() { return new Error(t('复制失败，请选中文本后按 Ctrl+C（macOS 使用 ⌘C）复制。')); }

/** Browser preview fallback. Desktop calls the native IPC bridge instead. */
export async function copyBrowserText(value: unknown, environment: BrowserClipboardEnvironment = {
  clipboard: globalThis.navigator?.clipboard,
  document: globalThis.document,
}): Promise<void> {
  const text = clipboardText(value);
  if (environment.clipboard?.writeText) {
    try {
      await environment.clipboard.writeText(text);
      return;
    } catch { /* Permissions or an insecure context can require the legacy path. */ }
  }

  const document = environment.document;
  if (!document?.body || typeof document.execCommand !== 'function') throw copyFailure();
  const focused = document.activeElement as HTMLElement | null;
  // Keep the temporary field inside the active modal's focus trap. Appending it
  // to body can redirect focus and make execCommand copy unrelated selection.
  const activeDialog = focused?.closest<HTMLElement>('[role="dialog"]');
  const visibleDialogs = activeDialog ? [] : Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], dialog[open]'))
    .filter(dialog => dialog.getClientRects().length > 0 && dialog.getAttribute('aria-hidden') !== 'true' && !dialog.hasAttribute('inert'));
  const container = activeDialog ?? visibleDialogs.at(-1) ?? document.body;
  const input = focused as HTMLInputElement | HTMLTextAreaElement | null;
  const inputStart = input?.selectionStart;
  const inputEnd = input?.selectionEnd;
  const inputDirection = input?.selectionDirection;
  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index++) ranges.push(selection.getRangeAt(index).cloneRange());
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.tabIndex = -1;
  field.style.position = 'fixed';
  field.style.left = '-10000px';
  field.style.top = '0';
  field.style.opacity = '0';
  field.style.fontSize = '16px';
  try {
    container.appendChild(field);
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    if (document.activeElement !== field || field.selectionStart !== 0 || field.selectionEnd !== text.length) throw copyFailure();
    if (document.execCommand('copy') !== true) throw copyFailure();
  } catch {
    throw copyFailure();
  } finally {
    field.remove();
    // Copying should not leave the user's focus or text selection elsewhere.
    // Restoration failure does not turn a completed copy into a false error.
    try { focused?.focus({ preventScroll: true }); } catch { /* The old element may have been removed. */ }
    try {
      if (input && typeof inputStart === 'number' && typeof inputEnd === 'number') {
        input.setSelectionRange(inputStart, inputEnd, inputDirection ?? undefined);
      } else if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    } catch { /* The selected DOM nodes may have changed while copying. */ }
  }
}
