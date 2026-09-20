// =============================================================================
// ProtectedMedia component tests (Session 09, D3).
//
// jsdom + @testing-library/react — see vitest.config.ts for why. jsdom does not
// implement HTMLMediaElement playback, so `pause`/`play` are stubbed on the
// prototype; the properties under test are about *when* they are called.
//
//   * the context menu is prevented over the wrapped region
//   * drag-start is prevented and selection is disabled
//   * hiding the tab / blurring the window blurs the content and pauses a
//     playing video; returning unblurs and resumes only what we paused
//   * the trace code prop is rendered as a persistent overlay
//   * listeners are removed on unmount
//   * (Session 10) the region name and the live-region text come from the
//     active locale's catalog — asserted for both pt-BR and en
//
// Session 10: the component reads its strings through `useTranslations`, so
// every render here sits under a `NextIntlClientProvider` carrying the real
// catalog files — the expected strings are read from those same files rather
// than repeated as literals.
// =============================================================================
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '@creator-platform/shared';
import en from '../../messages/en.json';
import ptBR from '../../messages/pt-BR.json';
import { ProtectedMedia } from './ProtectedMedia';

const IMG_ALT = 'placeholder';

const CATALOG = { en, 'pt-BR': ptBR } as const;

/** Render under the real catalog for `locale` (pt-BR — the default — unless told otherwise). */
function renderIn(ui: ReactElement, locale: Locale = 'pt-BR') {
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOG[locale]}>
      {ui}
    </NextIntlClientProvider>,
  );
}

/** Flip `document.visibilityState` and fire the event inside React's act(). */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  fireEvent(document, new Event('visibilitychange'));
}

const wrapper = () =>
  screen.getByRole('group', { name: CATALOG['pt-BR'].protectedMedia.defaultLabel });
const content = () => screen.getByTestId('protected-media-content');

describe('ProtectedMedia', () => {
  let pause: ReturnType<typeof vi.fn>;
  let play: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pause = vi.fn();
    play = vi.fn(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause as () => void);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play as () => Promise<void>);
    setVisibility('visible');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the trace code as a persistent overlay', () => {
    renderIn(
      <ProtectedMedia traceCode="7K3MQ2XA">
        <img src="data:," alt={IMG_ALT} />
      </ProtectedMedia>,
    );
    const overlay = screen.getByTestId('protected-media-trace');
    expect(overlay.textContent).toBe('7K3MQ2XA');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.style.pointerEvents).toBe('none');
    // Still there while obscured — the code must stay in frame.
    setVisibility('hidden');
    expect(screen.getByTestId('protected-media-trace').textContent).toBe('7K3MQ2XA');
  });

  it('prevents the context menu over the wrapped region', () => {
    renderIn(
      <ProtectedMedia traceCode="AAAAAAAA">
        <img src="data:," alt={IMG_ALT} />
      </ProtectedMedia>,
    );
    // Dispatched on the child: the wrapper handles it as it bubbles.
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    screen.getByAltText(IMG_ALT).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('prevents drag-start and disables selection', () => {
    renderIn(
      <ProtectedMedia traceCode="AAAAAAAA">
        <img src="data:," alt={IMG_ALT} />
      </ProtectedMedia>,
    );
    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    screen.getByAltText(IMG_ALT).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(wrapper().getAttribute('draggable')).toBe('false');
    expect(wrapper().style.userSelect).toBe('none');
  });

  it('blurs the content and pauses a playing video when the tab is hidden; restores on return', () => {
    renderIn(
      <ProtectedMedia traceCode="AAAAAAAA">
        <video muted data-testid="v" />
      </ProtectedMedia>,
    );
    const video = screen.getByTestId('v') as HTMLVideoElement;
    // jsdom reports `paused: true` by default; make it "playing".
    Object.defineProperty(video, 'paused', { value: false, configurable: true });

    expect(wrapper().getAttribute('data-obscured')).toBe('false');
    expect(content().style.filter).toBe('none');

    setVisibility('hidden');
    expect(wrapper().getAttribute('data-obscured')).toBe('true');
    expect(content().style.filter).toContain('blur(');
    expect(pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe(CATALOG['pt-BR'].protectedMedia.obscured);

    setVisibility('visible');
    expect(wrapper().getAttribute('data-obscured')).toBe('false');
    expect(content().style.filter).toBe('none');
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('blurs on window blur and restores on focus, but resumes only videos it paused', () => {
    renderIn(
      <ProtectedMedia traceCode="AAAAAAAA">
        <video muted data-testid="already-paused" />
      </ProtectedMedia>,
    );
    // Default jsdom state: paused. We must not start it on return.
    fireEvent.blur(window);
    expect(wrapper().getAttribute('data-obscured')).toBe('true');
    expect(pause).not.toHaveBeenCalled();

    fireEvent.focus(window);
    expect(wrapper().getAttribute('data-obscured')).toBe('false');
    expect(play).not.toHaveBeenCalled();
  });

  it('stays obscured on focus while the document is still hidden', () => {
    renderIn(
      <ProtectedMedia traceCode="AAAAAAAA">
        <img src="data:," alt={IMG_ALT} />
      </ProtectedMedia>,
    );
    setVisibility('hidden');
    fireEvent.focus(window);
    expect(wrapper().getAttribute('data-obscured')).toBe('true');
    setVisibility('visible');
    expect(wrapper().getAttribute('data-obscured')).toBe('false');
  });

  // ── Session 10 (D1): strings come from the catalog, per locale ───────────
  it.each(['en', 'pt-BR'] as const)(
    '%s: reads the live-region text and the default label from the catalog',
    (locale) => {
      const expected = CATALOG[locale].protectedMedia;
      const other = CATALOG[locale === 'en' ? 'pt-BR' : 'en'].protectedMedia;
      renderIn(
        <ProtectedMedia traceCode="AAAAAAAA">
          <img src="data:," alt={IMG_ALT} />
        </ProtectedMedia>,
        locale,
      );
      // Region name: the catalog default, and not the other language's.
      expect(screen.getByRole('group', { name: expected.defaultLabel })).toBeTruthy();
      expect(screen.queryByRole('group', { name: other.defaultLabel })).toBeNull();

      // Live region: empty until obscured, then exactly the catalog string.
      expect(screen.getByRole('status').textContent).toBe('');
      setVisibility('hidden');
      expect(screen.getByRole('status').textContent).toBe(expected.obscured);
      expect(screen.getByRole('status').textContent).not.toBe(other.obscured);
      setVisibility('visible');
      expect(screen.getByRole('status').textContent).toBe('');
    },
  );

  it('an explicit label prop overrides the catalog default', () => {
    renderIn(
      <ProtectedMedia traceCode="AAAAAAAA" label="Custom name">
        <img src="data:," alt={IMG_ALT} />
      </ProtectedMedia>,
      'en',
    );
    expect(screen.getByRole('group', { name: 'Custom name' })).toBeTruthy();
  });

  it('removes its listeners on unmount', () => {
    const { unmount } = renderIn(
      <ProtectedMedia traceCode="AAAAAAAA">
        <img src="data:," alt={IMG_ALT} />
      </ProtectedMedia>,
    );
    const removeDoc = vi.spyOn(document, 'removeEventListener');
    const removeWin = vi.spyOn(window, 'removeEventListener');
    unmount();
    expect(removeDoc).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith('focus', expect.any(Function));
  });
});
