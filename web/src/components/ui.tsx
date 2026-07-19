import { useEffect, useRef, useState, type ReactNode, type MouseEvent } from "react";

const prefersReduced = (): boolean =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A pointer-reactive 3D tilt wrapper. Falls back to no motion when reduced. */
export function Tilt({ children, className = "", max = 7 }: { children: ReactNode; className?: string; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = prefersReduced();
  const onMove = (e: MouseEvent): void => {
    if (reduced) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--rx", `${(-py * max).toFixed(2)}deg`);
    el.style.setProperty("--ry", `${(px * max).toFixed(2)}deg`);
    el.style.setProperty("--gx", `${((px + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty("--gy", `${((py + 0.5) * 100).toFixed(1)}%`);
  };
  const reset = (): void => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  };
  return (
    <div ref={ref} className={`tiltwrap ${className}`} onMouseMove={onMove} onMouseLeave={reset}>
      {children}
    </div>
  );
}

/** Attach a cursor-following spotlight (sets --mx/--my on the element). */
export function useSpotlight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const onMove = (e: MouseEvent): void => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return { ref, onMouseMove: onMove };
}

/** Wrap children to fade/slide in when scrolled into view. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) e.target.classList.add("in");
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`reveal ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Animated count-up number that runs once when scrolled into view. */
export function Counter({ to, suffix = "", duration = 1200 }: { to: number; suffix?: string; duration?: number }) {
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [val, setVal] = useState(reduced ? to : 0);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reduced) {
      setVal(to);
      return;
    }
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let started = false;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !started) {
            started = true;
            const t0 = performance.now();
            const tick = (t: number): void => {
              const p = Math.min(1, (t - t0) / duration);
              setVal(Math.round(easeOut(p) * to));
              if (p < 1) raf = requestAnimationFrame(tick);
            };
            raf = requestAnimationFrame(tick);
            io.disconnect();
          }
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [to, duration, reduced]);
  return (
    <span ref={ref}>
      {val}
      {suffix}
    </span>
  );
}

export function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="cmd">
      <span className="prompt">$</span>
      <code>{text}</code>
      <button onClick={copy}>{copied ? "copied ✓" : "copy"}</button>
    </div>
  );
}

