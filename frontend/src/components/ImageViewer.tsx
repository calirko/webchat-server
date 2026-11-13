import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

const MIN = 1;
const MAX = 6;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 8; // px a pointer may move and still count as a tap

type View = { s: number; x: number; y: number };
type Pt = { x: number; y: number };

const clampScale = (s: number) => Math.min(MAX, Math.max(MIN, s));

/**
 * Full-screen image viewer with zoom: pinch / double-tap on touch, wheel /
 * double-click on desktop, drag to pan while zoomed. Tap the backdrop (or Esc)
 * to close.
 *
 * Rendered in a portal on <body>: message rows set `touch-action: pan-y` for
 * swipe-to-reply, and an overlay nested inside one inherits that and the
 * browser refuses to pinch. React still bubbles synthetic events through the
 * portal to its React parents, so the root stops pointer/click/contextmenu
 * propagation — otherwise panning here would drive the row's swipe gesture.
 */
export default function ImageViewer({
  url,
  alt,
  onClose,
  download,
}: {
  url: string;
  alt: string;
  onClose: () => void;
  /** filename for the download button; omit to hide it */
  download?: string;
}) {
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [animate, setAnimate] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{
    start: View;
    // pinch: content point under the midpoint at gesture start + start distance
    anchor?: Pt;
    dist?: number;
    // pan: pointer position at gesture start
    origin?: Pt;
    moved: boolean;
    onImage: boolean;
  } | null>(null);
  const lastTap = useRef<{ t: number; p: Pt } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // keep the page underneath from scrolling while the viewer is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  /** client point → coordinates relative to the stage centre */
  function local(p: Pt): Pt {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: p.x - (r.left + r.width / 2), y: p.y - (r.top + r.height / 2) };
  }

  /** keep the zoomed image covering the stage instead of drifting off it */
  function clamp(v: View): View {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return v;
    const mx = Math.max(0, (img.offsetWidth * v.s - stage.clientWidth) / 2);
    const my = Math.max(0, (img.offsetHeight * v.s - stage.clientHeight) / 2);
    return { s: v.s, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
  }

  /** zoom to scale s keeping the content under focal point f (stage-local) fixed */
  function zoomAt(from: View, s: number, f: Pt): View {
    const cx = (f.x - from.x) / from.s;
    const cy = (f.y - from.y) / from.s;
    return { s, x: f.x - s * cx, y: f.y - s * cy };
  }

  function beginGesture(onImage: boolean) {
    const pts = [...pointers.current.values()];
    const start = viewRef.current;
    if (pts.length >= 2) {
      const [a, b] = pts;
      const mid = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      gesture.current = {
        start,
        anchor: { x: (mid.x - start.x) / start.s, y: (mid.y - start.y) / start.s },
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        moved: true, // a pinch is never a tap
        onImage,
      };
    } else if (pts.length === 1) {
      gesture.current = { start, origin: pts[0], moved: false, onImage };
    } else {
      gesture.current = null;
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setAnimate(false);
    beginGesture(gesture.current?.onImage || e.target === imgRef.current);
  }

  function onPointerMove(e: React.PointerEvent) {
    e.stopPropagation();
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const pts = [...pointers.current.values()];

    if (pts.length >= 2 && g.anchor && g.dist) {
      const [a, b] = pts;
      const mid = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      // allow a little rubber-band below 1×; it snaps back on release
      const s = Math.min(MAX, Math.max(MIN * 0.7, (g.start.s * Math.hypot(a.x - b.x, a.y - b.y)) / g.dist));
      setView({ s, x: mid.x - s * g.anchor.x, y: mid.y - s * g.anchor.y });
    } else if (pts.length === 1 && g.origin) {
      const dx = pts[0].x - g.origin.x;
      const dy = pts[0].y - g.origin.y;
      if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP) g.moved = true;
      if (g.moved && g.start.s > 1) setView(clamp({ s: g.start.s, x: g.start.x + dx, y: g.start.y + dy }));
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    e.stopPropagation();
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;

    if (pointers.current.size > 0) {
      // pinch → one finger left: continue as a pan from here
      beginGesture(g?.onImage ?? false);
      if (gesture.current) gesture.current.moved = true;
      return;
    }
    gesture.current = null;

    // settle: snap back from rubber-band, keep inside bounds
    const v = viewRef.current;
    if (v.s <= MIN) {
      if (v.s !== 1 || v.x !== 0 || v.y !== 0) {
        setAnimate(true);
        setView({ s: 1, x: 0, y: 0 });
      }
    } else {
      const c = clamp(v);
      if (c.x !== v.x || c.y !== v.y) {
        setAnimate(true);
        setView(c);
      }
    }

    if (!g || g.moved || e.type === 'pointercancel') return;

    // a tap: double-tap toggles zoom; a single tap on the backdrop closes
    const p = { x: e.clientX, y: e.clientY };
    const prev = lastTap.current;
    const now = performance.now();
    if (prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(p.x - prev.p.x, p.y - prev.p.y) < 30) {
      lastTap.current = null;
      setAnimate(true);
      const cur = viewRef.current;
      setView(cur.s > 1 ? { s: 1, x: 0, y: 0 } : clamp(zoomAt(cur, DOUBLE_TAP_SCALE, local(p))));
      return;
    }
    lastTap.current = { t: now, p };
    if (!g.onImage && viewRef.current.s <= 1) onClose();
  }

  function onWheel(e: React.WheelEvent) {
    e.stopPropagation();
    setAnimate(false);
    const cur = viewRef.current;
    const s = clampScale(cur.s * Math.exp(-e.deltaY * 0.002));
    setView(s === 1 ? { s: 1, x: 0, y: 0 } : clamp(zoomAt(cur, s, local({ x: e.clientX, y: e.clientY }))));
  }

  const stop = (e: SyntheticEvent) => e.stopPropagation();

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-[60] flex flex-col bg-black/95 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] select-none"
      onClick={stop}
      onContextMenu={stop}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
    >
      <div className="flex shrink-0 items-center justify-end gap-2 p-2">
        {view.s > 1 && (
          <button
            onClick={() => {
              setAnimate(true);
              setView({ s: 1, x: 0, y: 0 });
            }}
            className="mr-auto rounded-full px-3 py-2 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white"
          >
            {Math.round(view.s * 100)}% · Reset
          </button>
        )}
        {download && (
          <a
            href={url}
            download={download}
            title="Download"
            aria-label="Download image"
            className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
          </a>
        )}
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close image viewer"
          className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <img
          ref={imgRef}
          src={url}
          alt={alt}
          draggable={false}
          className={`max-h-full max-w-full object-contain will-change-transform ${
            view.s > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
          }`}
          style={{
            transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.s})`,
            transition: animate ? 'transform 0.2s ease-out' : 'none',
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
