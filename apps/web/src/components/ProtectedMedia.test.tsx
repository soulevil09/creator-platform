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
// =============================================================================
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtectedMedia } from './ProtectedMedia';

const IMG_ALT = 'placeholder';

/** Flip `document.visibilityState` and fire the event inside React's act(). */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  fireEvent(document, new Event('visibilitychange'));
}

const wrapper = () => screen.getByRole('group', { name: 'Conteúdo protegido' });
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
    render(
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
    render(
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
    render(
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
    render(
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
    expect(screen.getByRole('status').textContent).toMatch(/ocultado/i);

    setVisibility('visible');
    expect(wrapper().getAttribute('data-obscured')).toBe('false');
    expect(content().style.filter).toBe('none');
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('blurs on window blur and restores on focus, but resumes only videos it paused', () => {
    render(
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
    render(
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

  it('removes its listeners on unmount', () => {
    const { unmount } = render(
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
