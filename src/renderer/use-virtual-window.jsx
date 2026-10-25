import { useLayoutEffect, useRef, useState } from 'react';

// Fixed-height rows preserve the full scroll extent while bounding DOM work.
export function useVirtualWindow(count, rowHeight, resetKey, offset = 0) {
  const viewport = useRef(null);
  const [window, setWindow] = useState({ start: 0, end: Math.min(count, 32) });
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return undefined;
    node.scrollTop = 0;
    let frame;
    const measure = () => {
      frame = undefined;
      const first = Math.max(0, Math.floor((node.scrollTop - offset) / rowHeight));
      const start = Math.min(Math.max(0, count - 1), Math.max(0, first - 4));
      const end = Math.min(count, first + Math.ceil(node.clientHeight / rowHeight) + 5);
      setWindow((old) => old.start === start && old.end === end ? old : { start, end });
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    node.addEventListener('scroll', schedule, { passive: true });
    measure();
    return () => { observer.disconnect(); node.removeEventListener('scroll', schedule); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [count, rowHeight, resetKey, offset]);
  const start = Math.min(window.start, Math.max(0, count - 1));
  const end = Math.min(count, Math.max(start, window.end));
  return { viewport, start, end, top: start * rowHeight, bottom: Math.max(0, count - end) * rowHeight };
}
