import { useEffect } from "react";

/** Runs `callback` immediately, then every `intervalMs`, cleaning up on unmount or a dependency change. */
export function usePolling(callback: () => void, intervalMs: number): void {
  useEffect(() => {
    callback();
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }, [callback, intervalMs]);
}
