import { useEffect, useRef } from "react";

/** Close enough to the bottom to count as "still following the tail" after a manual scroll. */
const BOTTOM_THRESHOLD_PX = 40;

/**
 * A log view that auto-scrolls to the bottom as new lines arrive — like `tail -f` — but stops once the
 * viewer scrolls up to read something earlier, so a live stream never yanks them back down while
 * they're reading. Resumes auto-scrolling on its own once they scroll back near the bottom.
 */
export function LogView({ text }: { readonly text: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
  };

  return (
    <pre className="log-view" ref={ref} onScroll={onScroll}>
      {text || "(sin salida todavía)"}
    </pre>
  );
}
