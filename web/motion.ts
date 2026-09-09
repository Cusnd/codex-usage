import { useLayoutEffect, useRef } from "react";

/** A single ink rule follows the selected item, including after font/viewport changes. */
export function useActiveRule<T extends HTMLElement>(identity: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>(
        ".active, [aria-pressed='true']",
      );
      if (!active) {
        root.removeAttribute("data-rule-ready");
        return;
      }
      root.style.setProperty("--rule-x", `${active.offsetLeft}px`);
      root.style.setProperty("--rule-width", `${active.offsetWidth}px`);
      root.setAttribute("data-rule-ready", "true");
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    Array.from(root.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [identity]);
  return ref;
}
