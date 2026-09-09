import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export const motion = {
  feedback: 140, fade: 160, popup: 200, exit: 140, small: 220, panel: 260, travel: 240, chart: 320,
  ease: "cubic-bezier(0.22, 1, 0.36, 1)",
  leave: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

let preference: MediaQueryList | undefined;
const running = new Map<Element, Animation>();
function media() {
  if (!preference && typeof window !== "undefined") {
    preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    preference.addEventListener("change", () => {
      if (preference?.matches) for (const animation of running.values()) animation.finish();
    });
  }
  return preference;
}
const subscribeReduced = (notify: () => void) => {
  const query = media();
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};
export const reducedMotion = () => media()?.matches ?? false;
export function useReducedMotion() {
  return useSyncExternalStore(subscribeReduced, reducedMotion, () => false);
}

export function cancelMotion(element: Element) {
  const animation = running.get(element);
  if (!animation) return;
  running.delete(element);
  animation.cancel();
  element.removeAttribute("data-motion-running");
}

/** One interruptible animation per surface. Read its current geometry before calling. */
export function animateMotion(
  element: Element,
  frames: Keyframe[],
  duration: number = motion.panel,
  name = "reveal",
  complete?: () => void,
  easing: string = motion.ease,
) {
  cancelMotion(element);
  if (reducedMotion() || !element.animate) { complete?.(); return; }
  const animation = element.animate(frames, { duration, easing, fill: "both" });
  animation.id = `atlas:${name}`;
  running.set(element, animation);
  element.setAttribute("data-motion-running", name);
  animation.onfinish = () => {
    if (running.get(element) !== animation) return;
    running.delete(element);
    element.removeAttribute("data-motion-running");
    animation.cancel();
    complete?.();
  };
  return animation;
}

/** The same measured marker serves the navigation rule and segmented white surface. */
export function useActiveRule<T extends HTMLElement>(identity: string) {
  const ref = useRef<T>(null);
  const previous = useRef<string | undefined>(undefined);
  const geometry = useRef("");
  const measure = useRef<(animate: boolean) => void>(() => {});
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    measure.current = (animate) => {
      const active = root.querySelector<HTMLElement>(":scope > .active, :scope > [aria-pressed='true']");
      if (!active) { root.removeAttribute("data-rule-ready"); return; }
      const next = [active.offsetLeft, active.offsetTop, active.offsetWidth, active.offsetHeight, root.clientWidth, root.clientHeight];
      if (geometry.current === next.join("/")) return;
      geometry.current = next.join("/");
      root.dataset.ruleAnimate = String(animate && !reducedMotion());
      for (const [index, name] of ["x", "y", "width", "height"].entries())
        root.style.setProperty(`--rule-${name}`, `${next[index]}px`);
      root.dataset.ruleReady = "true";
    };
    measure.current(false);
    const observer = new ResizeObserver(() => measure.current(false));
    observer.observe(root);
    Array.from(root.children).forEach((child) => observer.observe(child));
    const fonts = () => measure.current(false);
    document.fonts?.addEventListener("loadingdone", fonts);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", fonts);
      geometry.current = "";
    };
  }, []);
  useLayoutEffect(() => {
    measure.current(previous.current !== undefined && previous.current !== identity);
    previous.current = identity;
  }, [identity]);
  return ref;
}

/** Identity means a user-visible change, never an arbitrary render or polling tick. */
export function useReveal<T extends HTMLElement>(
  identity: string | number,
  { ready = true, direction = 0, initial = false }: { ready?: boolean; direction?: number; initial?: boolean } = {},
) {
  const ref = useRef<T>(null);
  const last = useRef<string | number | undefined>(initial ? undefined : identity);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !ready || last.current === identity) return;
    last.current = identity;
    const inFlight = node.hasAttribute("data-motion-running");
    const from = inFlight ? getComputedStyle(node).opacity : "0";
    const distance = window.matchMedia("(max-width: 900px)").matches ? 16 : 8;
    animateMotion(node, [
      { opacity: from, transform: inFlight ? getComputedStyle(node).transform : `translateX(${direction * distance}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ], direction ? motion.travel : motion.fade, direction ? "hierarchy" : "result");
  }, [identity, ready, direction]);
  useLayoutEffect(() => {
    const node = ref.current;
    return () => { if (node) cancelMotion(node); };
  }, [ready]);
  return ref;
}

/** Clipboard completion cannot update a different task, and repeated copies reset the timer. */
export function useCopyFeedback(identity: string) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    generation.current++;
    clearTimeout(timer.current);
    setCopied(false); setError("");
    return () => { generation.current++; clearTimeout(timer.current); };
  }, [identity]);
  const copy = async (text: string) => {
    const attempt = ++generation.current;
    clearTimeout(timer.current);
    setError("");
    try {
      await navigator.clipboard.writeText(text);
      if (generation.current !== attempt) return;
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (generation.current !== attempt) return;
      setCopied(false); setError("复制失败，请手动选择并复制。");
    }
  };
  return { copied, error, copy };
}
