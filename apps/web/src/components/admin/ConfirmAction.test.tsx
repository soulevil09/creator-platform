// =============================================================================
// ConfirmAction tests (Session 11, D6).
//
// The one rule every admin action depends on: nothing fires on the first
// click. `onConfirm` runs only from the Confirm button in the revealed panel,
// a required reason keeps Confirm disabled until typed, and Cancel closes the
// panel without firing.
// =============================================================================
import { NextIntlClientProvider } from 'next-intl';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import { ConfirmAction } from './ConfirmAction';

const tc = en.admin.common;

function renderAction(props: Partial<Parameters<typeof ConfirmAction>[0]> = {}) {
  const onConfirm = vi.fn(async () => {});
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ConfirmAction label="Suspend" prompt="Really suspend?" onConfirm={onConfirm} {...props} />
    </NextIntlClientProvider>,
  );
  return { onConfirm };
}

afterEach(cleanup);

describe('ConfirmAction', () => {
  it('does not fire on the first click — only from Confirm inside the panel', async () => {
    const { onConfirm } = renderAction();
    const trigger = screen.getByRole('button', { name: 'Suspend' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group')).toBeNull();

    fireEvent.click(trigger);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('group', { name: 'Really suspend?' });
    expect(panel).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: tc.confirm }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
    await waitFor(() => expect(screen.queryByRole('group')).toBeNull());
  });

  it('cancel closes the panel without firing', () => {
    const { onConfirm } = renderAction();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    fireEvent.click(screen.getByRole('button', { name: tc.cancel }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('keeps Confirm disabled until a required reason is typed, then passes it through', async () => {
    const { onConfirm } = renderAction({ reasonLabel: 'Reason (required)', requireReason: true });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    const confirm = screen.getByRole('button', { name: tc.confirm }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason (required)'), {
      target: { value: '  fake references  ' },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('fake references'));
  });
});
