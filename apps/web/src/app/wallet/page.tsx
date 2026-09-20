'use client';

// Minimal wallet + credit-pack checkout screen (Session 05).
//
// Scope is deliberately small: read the balance, start a checkout, show what
// the provider returned. Enough to exercise the API end to end from a browser;
// the full purchase flow (polling for confirmation, receipt, history) lands
// with the rest of the subscriber UI.
//
// No payment credential ever reaches this file — a PIX charge comes back as a
// QR image plus a copia-e-cola string, and a crypto charge as an address plus
// an amount, both minted server-side.
//
// Accessibility notes: one `main` landmark with a single `h1`; the channel
// picker is a real `fieldset`/`legend` radio group; every control has an
// associated label or `aria-label`; async state is announced through a polite
// live region; the QR image carries descriptive alt text.
//
// Every user-facing string comes from the active locale's catalog (Session 10)
// via `useTranslations`; catalog labels (`pack.label`) are resolved with
// `resolveLabel` against `useLocale()`. Error codes the API returns
// (`insufficient_credits`, …) are machine codes and stay as they are.
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  CHECKOUT_CHANNELS,
  CREDIT_PACKS,
  CHANNEL_CURRENCY,
  resolveLabel,
  type CheckoutResponse,
  type CheckoutChannel,
  type Locale,
} from '@creator-platform/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Minor units → an amount in the UI's locale (`R$ 19,90` / `R$19.90`). */
function formatPrice(cents: number, currency: 'BRL' | 'USD', locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

const styles = {
  main: {
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    minHeight: '100vh',
    padding: '2rem 1.5rem 4rem',
    background: 'linear-gradient(160deg, #0f172a 0%, #1e293b 100%)',
    color: '#f8fafc',
  },
  shell: { maxWidth: 720, margin: '0 auto' },
  card: {
    border: '1px solid #334155',
    borderRadius: 12,
    padding: '1.25rem',
    background: 'rgba(148, 163, 184, 0.08)',
    marginTop: '1.5rem',
  },
  button: {
    padding: '0.55rem 1.1rem',
    borderRadius: 8,
    border: '1px solid #38bdf8',
    background: '#0ea5e9',
    color: '#04263a',
    fontWeight: 600,
    cursor: 'pointer',
  },
  code: {
    width: '100%',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.8rem',
    padding: '0.5rem',
    borderRadius: 6,
    border: '1px solid #334155',
    background: '#0b1220',
    color: '#e2e8f0',
  },
} as const;

export default function WalletPage() {
  const t = useTranslations('wallet');
  const locale = useLocale();
  const [balance, setBalance] = useState<number | null>(null);
  const [channel, setChannel] = useState<CheckoutChannel>('pix');
  const [charge, setCharge] = useState<CheckoutResponse | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const loadBalance = useCallback(async () => {
    try {
      // Cookie-based auth: the access token is httpOnly, so the browser must be
      // told to send it — there is no token for JS to read.
      const res = await fetch(`${API_URL}/api/wallet/balance`, { credentials: 'include' });
      if (res.status === 401) {
        setStatus(t('status.signInRequired'));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { balance: number };
      setBalance(data.balance);
      setStatus('');
    } catch {
      setStatus(t('status.balanceFailed'));
    }
  }, [t]);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  async function buy(packId: string) {
    setBusy(true);
    setCharge(null);
    setStatus(t('status.creatingCharge'));
    try {
      const res = await fetch(`${API_URL}/api/payments/checkout/credits`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packId, provider: channel }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus(body.error ?? t('status.checkoutFailed'));
        return;
      }
      const data = (await res.json()) as CheckoutResponse;
      setCharge(data);
      setStatus(t('status.chargeCreated'));
    } catch {
      setStatus(t('status.checkoutFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.shell}>
        <h1 style={{ fontSize: '2rem', margin: 0 }}>{t('title')}</h1>

        <section style={styles.card} aria-labelledby="balance-heading">
          <h2 id="balance-heading" style={{ margin: '0 0 0.5rem', fontSize: '1.1rem' }}>
            {t('balanceHeading')}
          </h2>
          <p style={{ fontSize: '2.25rem', fontWeight: 700, margin: 0 }}>
            {balance === null ? '—' : balance}
            <span style={{ fontSize: '1rem', color: '#94a3b8', marginLeft: 8 }}>
              {t('creditsUnit')}
            </span>
          </p>
          <button
            type="button"
            style={{ ...styles.button, marginTop: '1rem' }}
            onClick={loadBalance}
          >
            {t('refreshBalance')}
          </button>
        </section>

        <section style={styles.card} aria-labelledby="packs-heading">
          <h2 id="packs-heading" style={{ margin: '0 0 1rem', fontSize: '1.1rem' }}>
            {t('buyHeading')}
          </h2>

          <fieldset style={{ border: '1px solid #334155', borderRadius: 8, padding: '0.75rem' }}>
            <legend style={{ padding: '0 0.4rem', color: '#cbd5e1' }}>{t('paymentMethod')}</legend>
            {CHECKOUT_CHANNELS.map((option) => (
              <label
                key={option}
                htmlFor={`channel-${option}`}
                style={{ marginRight: '1.25rem', cursor: 'pointer' }}
              >
                <input
                  id={`channel-${option}`}
                  type="radio"
                  name="channel"
                  value={option}
                  checked={channel === option}
                  onChange={() => setChannel(option)}
                  style={{ marginRight: 6 }}
                />
                {t(`channel.${option}`)}
              </label>
            ))}
          </fieldset>

          <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0' }}>
            {CREDIT_PACKS.map((pack) => (
              <li
                key={pack.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  padding: '0.75rem 0',
                  borderTop: '1px solid #1e293b',
                }}
              >
                <span>
                  <strong>{resolveLabel(pack.label, locale)}</strong>
                  <span style={{ color: '#94a3b8', marginLeft: 8 }}>
                    {t('packSummary', {
                      credits: pack.credits,
                      price: formatPrice(
                        pack.price[CHANNEL_CURRENCY[channel]],
                        CHANNEL_CURRENCY[channel],
                        locale,
                      ),
                    })}
                  </span>
                </span>
                <button
                  type="button"
                  style={{ ...styles.button, opacity: busy ? 0.6 : 1 }}
                  disabled={busy}
                  aria-busy={busy}
                  aria-label={t('buyAria', {
                    pack: resolveLabel(pack.label, locale),
                    credits: pack.credits,
                  })}
                  onClick={() => buy(pack.id)}
                >
                  {t('buy')}
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Announced to assistive technology without stealing focus. */}
        <p role="status" aria-live="polite" style={{ marginTop: '1rem', color: '#cbd5e1' }}>
          {status}
        </p>

        {charge?.payment.method === 'pix' && (
          <section style={styles.card} aria-labelledby="pix-heading">
            <h2 id="pix-heading" style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>
              {t('pix.heading')}
            </h2>
            {/* Plain <img>: the QR is a provider-hosted URL on a host we do not
                know ahead of time, so next/image's remotePatterns cannot cover
                it, and the image is single-use — nothing to optimize or cache. */}
            {charge.payment.qrCodeImage && (
              <img
                src={charge.payment.qrCodeImage}
                alt={t('pix.qrAlt')}
                width={220}
                height={220}
                style={{ background: '#fff', borderRadius: 8, padding: 8 }}
              />
            )}
            <label htmlFor="brcode" style={{ display: 'block', margin: '0.75rem 0 0.25rem' }}>
              {t('pix.copyPaste')}
            </label>
            <input id="brcode" style={styles.code} readOnly value={charge.payment.brCode} />
          </section>
        )}

        {charge?.payment.method === 'crypto' && (
          <section style={styles.card} aria-labelledby="crypto-heading">
            <h2 id="crypto-heading" style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>
              {t('crypto.heading')}
            </h2>
            <label htmlFor="pay-address" style={{ display: 'block', marginBottom: '0.25rem' }}>
              {t('crypto.address', { currency: charge.payment.payCurrency.toUpperCase() })}
            </label>
            <input
              id="pay-address"
              style={styles.code}
              readOnly
              value={charge.payment.payAddress}
            />
            <label htmlFor="pay-amount" style={{ display: 'block', margin: '0.75rem 0 0.25rem' }}>
              {t('crypto.amount')}
            </label>
            <input id="pay-amount" style={styles.code} readOnly value={charge.payment.payAmount} />
          </section>
        )}
      </div>
    </main>
  );
}
