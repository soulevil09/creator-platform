'use client';

// Two-step action button (Session 11, D6).
//
// Every state-changing admin action — approve/reject, suspend/reinstate, the
// manual payout run, resolving a report — goes through this component, so the
// "explicit confirmation before firing" rule lives in exactly one place: the
// first click only reveals a confirmation panel; `onConfirm` runs only from
// the Confirm button inside it. An optional text field collects a reason,
// and `requireReason` keeps Confirm disabled until one is typed.
//
// Accessibility: the panel is a `role="group"` labelled by its prompt, focus
// moves into it when it opens (and back to the trigger on cancel), the reason
// field has a real `<label>`, and the trigger reflects `aria-expanded`.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { adminStyles as s } from './styles';

export interface ConfirmActionProps {
  /** Trigger button text. */
  label: ReactNode;
  /** Question shown in the confirmation panel. */
  prompt: ReactNode;
  /** Runs only after the explicit Confirm click. */
  onConfirm: (reason?: string) => Promise<void> | void;
  /** Show a reason field, labelled with this text. */
  reasonLabel?: string;
  /** Keep Confirm disabled until the reason field is non-blank. */
  requireReason?: boolean;
  /** Disable the trigger (e.g. while another action is in flight). */
  disabled?: boolean;
  variant?: 'primary' | 'danger' | 'ghost';
  /** Extra content rendered inside the panel above the buttons (e.g. a select). */
  children?: ReactNode;
}

export function ConfirmAction({
  label,
  prompt,
  onConfirm,
  reasonLabel,
  requireReason = false,
  disabled = false,
  variant = 'primary',
  children,
}: ConfirmActionProps) {
  const t = useTranslations('admin.common');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const buttonStyle =
    variant === 'danger' ? s.buttonDanger : variant === 'ghost' ? s.buttonGhost : s.button;

  function cancel() {
    setOpen(false);
    setReason('');
    triggerRef.current?.focus();
  }

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm(reasonLabel ? reason.trim() || undefined : undefined);
      setOpen(false);
      setReason('');
    } finally {
      setBusy(false);
    }
  }

  const confirmDisabled = busy || (requireReason && reason.trim() === '');

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        style={{ ...buttonStyle, opacity: disabled ? 0.6 : 1 }}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && (
        <div
          id={`${id}-panel`}
          ref={panelRef}
          role="group"
          aria-labelledby={`${id}-prompt`}
          tabIndex={-1}
          style={s.confirmPanel}
        >
          <p id={`${id}-prompt`} style={{ margin: '0 0 0.5rem' }}>
            {prompt}
          </p>
          {children}
          {reasonLabel && (
            <div style={{ margin: '0.5rem 0' }}>
              <label htmlFor={`${id}-reason`} style={s.label}>
                {reasonLabel}
              </label>
              <input
                id={`${id}-reason`}
                style={{ ...s.input, width: '100%', boxSizing: 'border-box' }}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
              />
            </div>
          )}
          <div style={s.row}>
            <button
              type="button"
              style={{ ...buttonStyle, opacity: confirmDisabled ? 0.6 : 1 }}
              disabled={confirmDisabled}
              aria-busy={busy}
              onClick={() => void confirm()}
            >
              {t('confirm')}
            </button>
            <button type="button" style={s.buttonGhost} disabled={busy} onClick={cancel}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
