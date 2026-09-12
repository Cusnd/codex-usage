import { useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { OverlayScope, usePresence } from "../motion/MotionPrimitives.js";
export type ChoiceOption = {
  value: string;
  label: string;
  description?: string;
};

/** A DOM-rendered listbox: no OS popup, including inside the Codex in-app browser. */
export function Choice({
  label,
  value,
  options,
  onChange,
  searchable = false,
  disabled = false,
  allowCustom = false,
  placeholder = "请选择",
}: {
  label: string;
  value: string;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  searchable?: boolean;
  disabled?: boolean;
  allowCustom?: boolean | ((value: string) => boolean);
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState("");
  const scope = useContext(OverlayScope);
  const visible = open && scope.active;
  const [opensAbove, setOpensAbove] = useState(false);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({
    left: 0,
    top: 0,
    width: 280,
    maxHeight: 320,
  });
  const presence = usePresence(visible, { popup: true, above: opensAbove });
  const popup = presence.ref;
  const trigger = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const selected = options.find((x) => x.value === value);
  let filtered = options.filter((x) =>
    (x.label + " " + (x.description || ""))
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  if (
    allowCustom &&
    (typeof allowCustom !== "function" || allowCustom(search.trim())) &&
    search.trim() &&
    !options.some((x) => x.value === search.trim())
  )
    filtered = [
      ...filtered,
      { value: search.trim(), label: "使用 " + search.trim() },
    ];
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  const show = () => {
    if (disabled) return;
    const rect = trigger.current!.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const width = Math.min(Math.max(rect.width, 260), viewportWidth - 24);
    const below = document.documentElement.clientHeight - rect.bottom - 16,
      above = rect.top - 16;
    const upwards = below < Math.min(260, above);
    const height = Math.min(360, upwards ? above : below);
    setOpensAbove(upwards);
    setPosition({
      left: Math.max(12, Math.min(rect.left, viewportWidth - width - 12)),
      ...(upwards ? { bottom: document.documentElement.clientHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      width,
      maxHeight: height,
    });
    setSearch("");
    setOpen(true);
  };
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() =>
      searchable
        ? input.current?.focus()
        : optionRefs.current[
            Math.max(
              0,
              options.findIndex((x) => x.value === value),
            )
          ]?.focus(),
    );
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close();
    };
    const resize = () => close();
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", resize);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [visible]);
  useEffect(() => { if (!scope.active) setOpen(false); }, [scope.active]);
  const choose = (next: string) => {
    onChange(next);
    close(true);
  };
  return (
    <div className="choice">
      <button
        ref={trigger}
        type="button"
        className="choice-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={visible}
        aria-controls={presence.present ? id : undefined}
        disabled={disabled}
        title={selected?.description || selected?.label || value}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span>{selected?.label || value || placeholder}</span>
        <ChevronDown
          className="choice-caret"
          size={16}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </button>
      {presence.present &&
        createPortal(
          <div
            ref={popup}
            className="choice-popup"
            data-side={opensAbove ? "above" : "below"}
            data-overlay-owners={scope.owners.join(" ")}
            inert={!visible}
            aria-hidden={!visible}
            style={position}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close(true);
              } else if (e.key === "Tab") {
                close(true);
              } else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
              ) {
                e.preventDefault();
                const current = optionRefs.current.findIndex(
                  (x) => x === document.activeElement,
                );
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? filtered.length - 1
                      : e.key === "ArrowDown"
                        ? (current + 1) % filtered.length
                        : current <= 0
                          ? filtered.length - 1
                          : current - 1;
                optionRefs.current[next]?.focus();
              }
            }}
          >
            {searchable && (
              <input
                ref={input}
                className="choice-search"
                aria-label={"搜索" + label}
                placeholder={"搜索" + label}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filtered.length) {
                    e.preventDefault();
                    choose(filtered[0].value);
                  }
                }}
              />
            )}
            <div
              className="choice-options"
              role="listbox"
              aria-label={label + "选项"}
              id={id}
            >
              {filtered.map((option, index) => (
                <button
                  key={option.value}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  tabIndex={-1}
                  className="choice-option"
                  onClick={() => choose(option.value)}
                >
                  <span>
                    <b>{option.label}</b>
                    {option.description && <small>{option.description}</small>}
                  </span>
                  {option.value === value && (
                    <Check size={16} strokeWidth={1.8} aria-hidden="true" />
                  )}
                </button>
              ))}
              {!filtered.length && (
                <div className="choice-empty">没有匹配选项</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
