'use client';

// =============================================================================
// ProtectedMedia — client-side leak deterrents (Session 09, D3).
//
// ⚠️  THESE ARE DETERRENTS, NOT SECURITY CONTROLS.
// No web page can block an OS-level screenshot, a screen recorder, a phone
// pointed at the monitor, or a browser with DevTools open. What this component
// does is raise the cost of *casual* capture — right-click → "Save image",
// drag-to-desktop, leaving a video playing while switching to a recorder —
// and keep the per-viewer trace code visible over the media so that whatever
// does get captured carries a code the platform can resolve to a viewer
// through the AuditLog. Nothing here should ever be described as leak-proof.
//
// The real protections live server-side (Session 04/09): tier-gated access,
// short-TTL signed URLs, per-viewer forensic watermarking of images at serve
// time, and one AuditLog row per serve. This component is the last, weakest
// layer, on purpose.
//
// For video (Option B, see CLAUDE.md), the overlay here is the ONLY place the
// trace code appears: the file behind the signed URL is not watermarked, and a
// viewer who fetches that URL directly within its 60 s TTL gets the unmarked
// original. That residual risk is documented and accepted for the MVP.
// =============================================================================
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';

export interface ProtectedMediaProps {
  /**
   * The per-viewer forensic code returned by the API for this media — the
   * `traceCode` field of a video `/serve` response, or the code the image
   * endpoint burned into the bytes (rendered again here, belt and suspenders).
   */
  traceCode: string;
  /** The `<img>` or `<video>` (with its own controls) being protected. */
  children: ReactNode;
  /** Accessible name for the protected region; the catalog default if omitted. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const BLUR_PX = 24;

const styles = {
  wrapper: {
    position: 'relative',
    display: 'inline-block',
    maxWidth: '100%',
    lineHeight: 0,
    // No text selection or long-press callout over the media; drag is
    // cancelled in the handler because CSS alone does not stop it everywhere.
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  },
  content: {
    display: 'inline-block',
    maxWidth: '100%',
    transition: 'filter 120ms ease-out',
  },
  overlay: {
    position: 'absolute',
    right: '0.5rem',
    bottom: '0.5rem',
    padding: '0.15rem 0.45rem',
    borderRadius: 4,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.75rem',
    letterSpacing: '0.08em',
    lineHeight: 1.4,
    color: '#ffffff',
    background: 'rgba(0, 0, 0, 0.35)',
    opacity: 0.55,
    // Never intercept the player's controls, and never be draggable itself.
    pointerEvents: 'none',
  },
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
  },
} satisfies Record<string, CSSProperties>;

/**
 * Wraps a media element with client-side deterrents: no context menu, no
 * drag/selection, blur + pause while the tab is hidden or the window is not
 * focused, and a persistent low-opacity trace-code overlay.
 *
 * **Deterrent only.** This cannot prevent an OS-level screenshot, a screen
 * recorder, or an external camera; it makes casual capture more awkward and
 * keeps the forensic code in frame. Do not present it as a guarantee.
 */
export function ProtectedMedia({
  traceCode,
  children,
  label,
  className,
  style,
}: ProtectedMediaProps) {
  // Both strings this component owns — the region's default name and the
  // live-region announcement — come from the active locale's catalog
  // (Session 10), never from a literal.
  const t = useTranslations('protectedMedia');
  const [obscured, setObscured] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Videos this component paused, so only those are resumed on return. */
  const pausedByUs = useRef<Set<HTMLVideoElement>>(new Set());

  const obscure = useCallback(() => {
    setObscured(true);
    const root = contentRef.current;
    if (!root) return;
    for (const video of root.querySelectorAll('video')) {
      if (!video.paused) {
        pausedByUs.current.add(video);
        video.pause();
      }
    }
  }, []);

  const reveal = useCallback(() => {
    setObscured(false);
    for (const video of pausedByUs.current) {
      // Autoplay policy may refuse; that is fine — the user can press play.
      // (`play()` returns a Promise in browsers; guard for environments where
      // it does not, such as jsdom.)
      const playing: unknown = video.play();
      if (playing instanceof Promise) playing.catch(() => {});
    }
    pausedByUs.current.clear();
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') obscure();
      else reveal();
    };
    const onBlur = () => obscure();
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') reveal();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [obscure, reveal]);

  const prevent = useCallback((event: { preventDefault(): void }) => {
    event.preventDefault();
  }, []);

  return (
    <div
      role="group"
      aria-label={label ?? t('defaultLabel')}
      className={className}
      style={{ ...styles.wrapper, ...style }}
      data-obscured={obscured ? 'true' : 'false'}
      draggable={false}
      onContextMenu={prevent}
      onDragStart={prevent}
    >
      <div
        ref={contentRef}
        data-testid="protected-media-content"
        style={{ ...styles.content, filter: obscured ? `blur(${BLUR_PX}px)` : 'none' }}
      >
        {children}
      </div>
      {/* Forensic code, always in frame. Decorative for assistive tech. */}
      <span aria-hidden="true" data-testid="protected-media-trace" style={styles.overlay}>
        {traceCode}
      </span>
      {/* Tell screen-reader users why the media went away, and when it is back. */}
      <span role="status" style={styles.srOnly}>
        {obscured ? t('obscured') : ''}
      </span>
    </div>
  );
}

export default ProtectedMedia;
