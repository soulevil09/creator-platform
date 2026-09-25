// =============================================================================
// AdminGate tests (Session 11, D6).
//
// A UX convenience only — the server's `authorize('admin')` is the boundary —
// but the convenience must still do its one job: non-admins (and anonymous
// visitors) are sent to `/`, admins see the console. `fetch` is stubbed;
// `next/navigation` is mocked (no App Router in jsdom).
// =============================================================================
import { NextIntlClientProvider } from 'next-intl';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import { AdminGate } from './AdminGate';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

function stubMe(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: status < 400, status, json: async () => body })),
  );
}

function renderGate() {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminGate>
        <p>console content</p>
      </AdminGate>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => replace.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdminGate', () => {
  it('renders its children for an admin', async () => {
    stubMe(200, { userId: 'u_1', role: 'admin' });
    renderGate();
    expect(screen.getByRole('status').textContent).toBe(en.admin.gate.checking);
    await waitFor(() => expect(screen.getByText('console content')).toBeTruthy());
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects a signed-in non-admin to / and never renders the children', async () => {
    stubMe(200, { userId: 'u_2', role: 'subscriber' });
    renderGate();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('console content')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(en.admin.gate.redirecting);
  });

  it('redirects an anonymous visitor (401) to /', async () => {
    stubMe(401, { error: 'Unauthorized' });
    renderGate();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('console content')).toBeNull();
  });
});
