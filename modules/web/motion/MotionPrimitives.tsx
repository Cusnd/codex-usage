import {
  createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type HTMLAttributes, type ReactNode, type RefObject,
} from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { animateMotion, cancelMotion, motion, useActiveRule, useReveal } from "./motion.js";
import type { ResultMotion } from "./motion-state.js";

export const OverlayScope = createContext({ owners: [] as string[], active: true });

/** Keep an exiting surface mounted, but never interactive. A new direction cancels the old finish. */
export function usePresence(
  open: boolean,
  { popup = false, above = false, initial = false, duration = motion.panel, onExited }: {
    popup?: boolean; above?: boolean; initial?: boolean; duration?: number; onExited?: () => void;
  } = {},
) {
  const ref = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(open);
  const previous = useRef<boolean | undefined>(initial ? undefined : open);
  const exited = useRef(onExited);
  exited.current = onExited;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || previous.current === open) return;
    const wasOpen = previous.current;
    previous.current = open;
    const interrupted = node.hasAttribute("data-motion-running");
    const opacity = interrupted ? getComputedStyle(node).opacity : open ? "0" : "1";
    const height = interrupted || wasOpen ? node.getBoundingClientRect().height : 0;
    const transform = interrupted ? getComputedStyle(node).transform : `translateY(${open ? (above ? 6 : -6) : 0}px)`;
    cancelMotion(node);
    if (open) setPresent(true);
    const finish = () => {
      node.style.removeProperty("overflow");
      if (open) {
        node.style.removeProperty("height");
        node.style.removeProperty("opacity");
      } else {
        // WAAPI releases its fill synchronously; React removes the node on its next commit.
        // Keep the exit endpoint during that gap so natural height never flashes back.
        if (!popup) node.style.height = "0px";
        node.style.opacity = "0";
        setPresent(false); exited.current?.();
      }
    };
    if (popup) {
      animateMotion(node, [
        { opacity, transform },
        { opacity: open ? 1 : 0, transform: `translateY(${open ? 0 : above ? 6 : -6}px)` },
      ], open ? motion.popup : motion.exit, open ? "popup-open" : "popup-close", finish, open ? motion.ease : motion.leave);
    } else {
      node.style.overflow = "clip";
      animateMotion(node, [
        { height: `${height}px`, opacity },
        { height: `${open ? node.scrollHeight : 0}px`, opacity: open ? 1 : 0 },
      ], duration, open ? "expand" : "collapse", finish);
    }
  }, [open, popup, above, duration]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const inner = popup ? null : node.firstElementChild;
    let size = inner?.getBoundingClientRect().height;
    const observer = inner ? new ResizeObserver(() => {
      const next = inner.getBoundingClientRect().height;
      if (size === next) return;
      size = next;
      if (!node.inert && node.hasAttribute("data-motion-running")) {
        const height = node.getBoundingClientRect().height;
        const opacity = getComputedStyle(node).opacity;
        animateMotion(node, [{ height: `${height}px`, opacity }, { height: `${node.scrollHeight}px`, opacity: 1 }], duration, "expand", () => node.style.removeProperty("overflow"));
      }
    }) : undefined;
    if (inner) observer?.observe(inner);
    const finishOnResize = () => node.getAnimations().forEach((animation) => {
      if (animation.id.startsWith("atlas:")) animation.finish();
    });
    window.addEventListener("resize", finishOnResize);
    return () => { observer?.disconnect(); cancelMotion(node); window.removeEventListener("resize", finishOnResize); };
  }, [open || present, popup]);
  return { ref, present: open || present };
}

export function Collapse({ open, children, className = "", initial = false, duration = motion.panel, onExited }: {
  open: boolean; children: ReactNode; className?: string; initial?: boolean; duration?: number; onExited?: () => void;
}) {
  const presence = usePresence(open, { initial, duration, onExited });
  return presence.present ? (
    <div ref={presence.ref} className={`motion-collapse ${className}`} inert={!open} aria-hidden={!open}>
      <div className="motion-collapse-inner">{children}</div>
    </div>
  ) : null;
}

export function ExpandingRow({ open, colSpan, children }: { open: boolean; colSpan: number; children: ReactNode }) {
  const presence = usePresence(open);
  return presence.present ? <tr className="turn-expansion"><td colSpan={colSpan}>
    <div ref={presence.ref} className="motion-collapse" inert={!open} aria-hidden={!open}>
      <div className="motion-collapse-inner">{children}</div>
    </div>
  </td></tr> : null;
}

export function MotionDetails({
  summary, children, open: controlled, defaultOpen = false, onOpenChange, className = "", popup = false,
  contentClassName = "", detailsRef, duration = motion.small, form = false,
}: {
  summary: ReactNode; children: ReactNode; open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void;
  className?: string; popup?: boolean; contentClassName?: string; detailsRef?: RefObject<HTMLDetailsElement | null>; duration?: number; form?: boolean;
}) {
  const ownRef = useRef<HTMLDetailsElement>(null);
  const root = detailsRef || ownRef;
  const scope = useContext(OverlayScope);
  const id = useId();
  const [internal, setInternal] = useState(defaultOpen);
  const ownOpen = controlled ?? internal;
  const open = ownOpen && scope.active;
  const presence = usePresence(open, { popup, duration });
  const change = (next: boolean, restore = false) => {
    if (!next && (restore || presence.ref.current?.contains(document.activeElement)))
      root.current?.querySelector("summary")?.focus();
    setInternal(next); onOpenChange?.(next);
  };
  useEffect(() => {
    if (popup && !scope.active && ownOpen) { setInternal(false); onOpenChange?.(false); }
  }, [popup, scope.active, ownOpen, onOpenChange]);
  useEffect(() => {
    if (!open || !popup) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      const owners = target.closest?.("[data-overlay-owners]")?.getAttribute("data-overlay-owners")?.split(" ");
      if (!root.current?.contains(target) && !owners?.includes(id)) change(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, popup, id]);
  return (
    <details ref={root} className={`motion-details ${className}`} open={open || presence.present} data-expanded={open}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && open) {
          event.preventDefault(); event.stopPropagation(); change(false, true);
        }
      }}>
      <summary aria-expanded={open} aria-controls={id} onClick={(event) => { event.preventDefault(); change(!ownOpen); }}>
        {summary}
      </summary>
      {presence.present && (
        <div id={id} ref={presence.ref} className={popup ? contentClassName : `motion-collapse ${contentClassName}`}
          inert={!open} aria-hidden={!open}>
          <OverlayScope.Provider value={{ owners: [...scope.owners, id], active: open }}>
            {popup ? children : form ? <fieldset className="motion-collapse-inner" disabled={!open}>{children}</fieldset> : <div className="motion-collapse-inner">{children}</div>}
          </OverlayScope.Provider>
        </div>
      )}
    </details>
  );
}

export function Segmented({ value, children, label, small = false }: { value: string; children: ReactNode; label: string; small?: boolean }) {
  const ref = useActiveRule<HTMLDivElement>(value);
  return <div ref={ref} className={`segmented motion-segmented${small ? " motion-segmented-small" : ""}`} role="group" aria-label={label}>{children}</div>;
}

export function Updating({ pending }: { pending: boolean }) {
  return <span className="updating-slot" role="status">{pending ? "正在更新…" : ""}</span>;
}

export function AdaptiveRegion({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current!, inner = node.firstElementChild!;
    let previous = inner.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const height = inner.getBoundingClientRect().height;
      if (height === previous) return;
      const from = node.hasAttribute("data-motion-running") ? node.getBoundingClientRect().height : previous;
      previous = height;
      animateMotion(node, [{ height: `${from}px`, opacity: .35 }, { height: `${height}px`, opacity: 1 }], motion.small, "size-change");
    });
    observer.observe(inner);
    return () => { observer.disconnect(); cancelMotion(node); };
  }, []);
  return <div ref={ref} className={className}><div>{children}</div></div>;
}

export function ResultRegion({ change, pending = false, animate = true, children, className = "", ...props }: HTMLAttributes<HTMLDivElement> & {
  change: ResultMotion; pending?: boolean; animate?: boolean;
}) {
  const ref = useReveal<HTMLDivElement>(change.revision, { ready: animate && change.animate, initial: true });
  return <div {...props} className={`result-region ${className}`} aria-busy={pending}>
    <Updating pending={pending} />
    <div ref={ref}>{children}</div>
  </div>;
}

type ListEntry<T> = { key: string; item: T; present: boolean; added: boolean };
/** Stable React identities retain live form state while a removed row finishes exiting. */
export function PresenceList<T>({ items, itemKey, children, className = "", compact = false }: {
  items: readonly T[]; itemKey: (item: T) => string; children: (item: T, index: number, present: boolean) => ReactNode; className?: string; compact?: boolean;
}) {
  const current = new Map(items.map((item) => [itemKey(item), item]));
  const signature = JSON.stringify([...current.keys()]);
  const previousItems = useRef(current);
  const [state, setState] = useState(() => ({ signature, entries: items.map((item) => ({ key: itemKey(item), item, present: true, added: false })) }));
  if (state.signature !== signature) {
    const entries: ListEntry<T>[] = items.map((item) => ({ key: itemKey(item), item, present: true, added: !state.entries.some((entry) => entry.key === itemKey(item)) }));
    state.entries.forEach((entry, index) => {
      if (!current.has(entry.key)) entries.splice(Math.min(index, entries.length), 0, { ...entry, item: previousItems.current.get(entry.key) ?? entry.item, present: false });
    });
    setState({ signature, entries });
  }
  const ref = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    previousItems.current = current;
    if (!compact || !ref.current) return;
    const next = new Map<string, DOMRect>();
    for (const node of ref.current.querySelectorAll<HTMLElement>(":scope > [data-item-key]")) {
      const key = node.dataset.itemKey!;
      const rect = node.getBoundingClientRect();
      const old = positions.current.get(key);
      next.set(key, rect);
      if (old && (old.left !== rect.left || old.top !== rect.top))
        animateMotion(node, [{ transform: `translate(${old.left - rect.left}px, ${old.top - rect.top}px)` }, { transform: "translate(0, 0)" }], motion.fade, "list-position");
    }
    positions.current = next;
  });
  const remove = (key: string) => setState((old) => ({ ...old, entries: old.entries.filter((entry) => entry.key !== key || entry.present) }));
  return <div ref={ref} className={className}>
    {state.entries.map((entry) => <PresenceItem key={entry.key} itemKey={entry.key} present={entry.present} initial={entry.added} compact={compact} onExited={() => remove(entry.key)}>
      {children(current.get(entry.key) ?? entry.item, items.findIndex((item) => itemKey(item) === entry.key), entry.present)}
    </PresenceItem>)}
  </div>;
}

function PresenceItem({ present, initial, compact, children, onExited, itemKey }: {
  present: boolean; initial: boolean; compact: boolean; children: ReactNode; onExited: () => void; itemKey: string;
}) {
  const presence = usePresence(present, { popup: compact, initial, duration: motion.small, onExited });
  return presence.present ? <div className={compact ? "motion-chip" : "motion-collapse"} data-item-key={itemKey}>
    <div ref={presence.ref} inert={!present} aria-hidden={!present} className="motion-collapse-inner">{children}</div>
  </div> : null;
}

const NavigationMotion = createContext({ direction: 0, active: false, path: "" });
export function MotionNavigation({ children }: { children: ReactNode }) {
  const location = useLocation();
  const action = useNavigationType();
  const [state, setState] = useState({ path: location.pathname, active: false, direction: 0 });
  if (state.path !== location.pathname) {
    const beforeDetail = state.path.startsWith("/threads/");
    const afterDetail = location.pathname.startsWith("/threads/");
    setState({ path: location.pathname, active: beforeDetail || afterDetail, direction: action === "POP" || (beforeDetail && !afterDetail) ? -1 : 1 });
  }
  return <NavigationMotion.Provider value={state}>{children}</NavigationMotion.Provider>;
}

export function useHierarchyMotion<T extends HTMLElement>(identity: string, level: number, ready = true) {
  const navigation = useContext(NavigationMotion);
  const previous = useRef({ identity, level, path: navigation.path });
  const [direction, setDirection] = useState(navigation.active ? navigation.direction : 0);
  if (previous.current.identity !== identity) {
    const nextDirection = navigation.active && previous.current.path !== navigation.path ? navigation.direction : Math.sign(level - previous.current.level);
    previous.current = { identity, level, path: navigation.path };
    if (direction !== nextDirection) setDirection(nextDirection);
  }
  return useReveal<T>(identity, { ready, direction, initial: navigation.active });
}
