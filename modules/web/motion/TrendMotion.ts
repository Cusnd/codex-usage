import { useLayoutEffect, useRef, useState } from "react";
import { animateMotion, cancelMotion, motion } from "./motion.js";

const labels = ".atlas-total > span, .atlas-total > strong, .atlas-total dt, .atlas-total dd, .atlas-total > small";
type Layout = { height: number; chartWidth: number; labels: DOMRect[] };

/** Move summary labels without scaling text or resizing the plotted SVG every frame. */
export function useTrendLayout(collapsed: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(!collapsed);
  const previous = useRef(collapsed);
  const before = useRef<Layout | undefined>(undefined);
  const capture = () => {
    const root = ref.current;
    if (!root) return;
    before.current = {
      height: root.getBoundingClientRect().height,
      chartWidth: root.querySelector(".atlas-chart-panel")?.getBoundingClientRect().width || 0,
      labels: Array.from(root.querySelectorAll(labels), (node) => node.getBoundingClientRect()),
    };
  };
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || previous.current === collapsed || !before.current) { capture(); return; }
    previous.current = collapsed;
    const old = before.current;
    if (!collapsed) setPresent(true);
    cancelMotion(root);
    const chart = root.querySelector<HTMLElement>(".atlas-chart-panel");
    if (chart) {
      cancelMotion(chart);
      chart.style.width = collapsed ? `${old.chartWidth}px` : "";
      const width = chart.getBoundingClientRect().width;
      chart.style.width = `${width}px`;
      chart.inert = collapsed;
      animateMotion(chart, [{ opacity: collapsed ? 1 : 0 }, { opacity: collapsed ? 0 : 1 }], motion.panel, "trend-chart");
    }
    const height = root.getBoundingClientRect().height;
    root.querySelectorAll<HTMLElement>(labels).forEach((node, i) => {
      cancelMotion(node);
      const target = node.getBoundingClientRect();
      const origin = old.labels[i];
      if (origin) animateMotion(node, [
        { transform: `translate(${origin.left - target.left}px, ${origin.top - target.top}px)` },
        { transform: "translate(0, 0)" },
      ], motion.panel, "trend-summary");
    });
    root.style.overflow = "clip";
    animateMotion(root, [{ height: `${old.height}px` }, { height: `${height}px` }], motion.panel, "trend-layout", () => {
      root.style.removeProperty("overflow");
      chart?.style.removeProperty("width");
      if (collapsed) setPresent(false);
      capture();
    });
  }, [collapsed]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const observer = new ResizeObserver(() => { if (!root.hasAttribute("data-motion-running")) capture(); });
    observer.observe(root);
    const finish = () => {
      root.getAnimations({ subtree: true }).forEach((animation) => { if (animation.id.startsWith("atlas:")) animation.finish(); });
    };
    window.addEventListener("resize", finish);
    return () => {
      observer.disconnect(); window.removeEventListener("resize", finish);
      cancelMotion(root); root.querySelectorAll(labels + ", .atlas-chart-panel").forEach(cancelMotion);
    };
  }, []);
  return { ref, present: !collapsed || present, capture };
}
