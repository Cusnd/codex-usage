import { useLayoutEffect, useRef } from "react";

/** Spatial orientation on navigation; never animate polling or URL filter edits. */
export function useArrival<T extends HTMLElement>(identity: string, distance = 0, ready = true) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!root || !ready || preference.matches) return;
    const surface = root.querySelector(":scope > .atlas-page") || root;
    const elements = Array.from(surface.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    const animations = elements.map((element) => element.animate(
      [
        { opacity: 0.35, transform: `translateX(${distance}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      {
        duration: distance ? 240 : 180,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      },
    ));
    const cancel = () => animations.forEach((animation) => animation.cancel());
    preference.addEventListener("change", cancel);
    return () => {
      cancel();
      preference.removeEventListener("change", cancel);
    };
  }, [identity, distance, ready]);
  return ref;
}

/** A single ink rule follows the selected item, including after font/viewport changes. */
export function useActiveRule<T extends HTMLElement>(identity: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>(".active, [aria-pressed='true']");
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
