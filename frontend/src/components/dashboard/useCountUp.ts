import { useEffect, useRef, useState } from "react";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Animates a displayed number from its previous value to `target` once per
// change of `target` (never on unrelated re-renders). Returns the number to show.
export function useCountUp(target: number, duration = 650): number {
  const [shown, setShown] = useState<number>(() => (prefersReducedMotion() ? target : 0));
  const fromRef = useRef<number>(shown);

  useEffect(() => {
    if (prefersReducedMotion() || !Number.isFinite(target)) {
      fromRef.current = target;
      setShown(target);
      return undefined;
    }
    const from = fromRef.current;
    if (from === target) {
      setShown(target);
      return undefined;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(from + (target - from) * eased);
      fromRef.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return shown;
}
