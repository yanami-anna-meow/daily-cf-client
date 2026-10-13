import { useEffect, useId, useRef, type ReactNode } from 'react';
import { t } from '../../shared/i18n';

interface ModalProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  closable?: boolean;
}

const activeDialogs: HTMLElement[] = [];
let previousOverflow = '';

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'))
    .filter(element => !element.hasAttribute('disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
}

export function Modal({ title, subtitle, children, onClose, wide = false, closable = true }: ModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const closableRef = useRef(closable);
  const titleId = useId();
  const descriptionId = useId();
  closeRef.current = onClose;
  closableRef.current = closable;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (activeDialogs.length === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    activeDialogs.push(dialog);
    const frame = requestAnimationFrame(() => {
      const preferred = dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
      (preferred ?? focusableElements(dialog)[0] ?? dialog).focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (activeDialogs.at(-1) !== dialog) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (closableRef.current) { event.preventDefault(); closeRef.current(); }
      }
      if (event.key !== 'Tab') return;
      const elements = focusableElements(dialog);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (activeDialogs.at(-1) === dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        (focusableElements(dialog)[0] ?? dialog).focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      const position = activeDialogs.indexOf(dialog);
      if (position >= 0) activeDialogs.splice(position, 1);
      if (activeDialogs.length === 0) document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return <div className="modal-backdrop" onClick={event => {
    if (event.target === event.currentTarget && closable) onClose();
  }}>
    <section ref={dialogRef} className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={subtitle ? descriptionId : undefined} tabIndex={-1}>
      <header className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p id={descriptionId}>{subtitle}</p>}</div>
        {closable && <button className="modal-close icon-button" type="button" aria-label={t('关闭')} onClick={onClose}>×</button>}
      </header>
      <div className="modal-body">{children}</div>
    </section>
  </div>;
}

export default Modal;
