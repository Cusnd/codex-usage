import type { ModelPrice, Settings } from "../shared/contracts";
import { useData } from "./workspace";
import { ErrorBox } from "./ui";
import { X, Plus, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MotionDetails, PresenceList } from "./MotionPrimitives";
import { useReveal } from "./motion";

type PricingInfo = {
  prices: ModelPrice[];
  source: string;
  checkedAt: string;
  currency: string;
  tier: string;
};
const fields = [
  ["input", "普通输入"],
  ["cachedInput", "缓存读取"],
  ["cacheWrite", "缓存写入"],
  ["output", "输出"],
] as const;
const longFields = [
  ["longInput", "普通输入"],
  ["longCachedInput", "缓存读取"],
  ["longCacheWrite", "缓存写入"],
  ["longOutput", "输出"],
] as const;

export function PriceSettings({
  draft,
  setDraft,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
}) {
  const info = useData<PricingInfo>("pricing");
  const prices = draft.modelPrices || [];
  const [open, setOpen] = useState(Boolean(draft.costEnabled));
  useEffect(() => setOpen(Boolean(draft.costEnabled)), [draft.costEnabled]);
  const keys = useRef<string[]>([]);
  while (keys.current.length < prices.length) keys.current.push(crypto.randomUUID());
  if (keys.current.length > prices.length) keys.current.length = prices.length;
  const focusNext = useRef<string | "add" | undefined>(undefined);
  const root = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [reset, setReset] = useState(0);
  const resetMotion = useReveal<HTMLDivElement>(reset);
  useLayoutEffect(() => {
    if (!focusNext.current) return;
    if (focusNext.current === "add") addButton.current?.focus();
    else root.current?.querySelector<HTMLInputElement>(`[data-model-row="${focusNext.current}"] input`)?.focus();
    focusNext.current = undefined;
  }, [prices.length]);
  const change = (index: number, patch: Partial<ModelPrice>) =>
    setDraft({
      ...draft,
      modelPrices: prices.map((row, n) =>
        n === index ? { ...row, ...patch } : row,
      ),
    });
  return (
    <section className="price-settings" ref={root}>
      <div className="setting-row">
        <div>
          <label htmlFor="costEnabled">显示参考成本</label>
          <p>在摘要与明细中增加缓存写入、USD 参考成本。默认关闭。</p>
        </div>
        <input
          id="costEnabled"
          type="checkbox"
          checked={Boolean(draft.costEnabled)}
          onChange={(e) =>
            setDraft({ ...draft, costEnabled: e.target.checked })
          }
        />
      </div>
      <MotionDetails form open={open} onOpenChange={setOpen} duration={260} summary={<>
          模型参考单价 <span>USD / 百万 Token</span>
        </>}>
        <p className="footnote">
          按 Standard API 文本 Token
          价格估算，不代表订阅账单；不计工具费用、Fast／Batch／Flex
          或区域附加费。价格覆盖后对历史记录重新估算。
        </p>
        <p className="footnote">
          非缓存输入＝输入－缓存读取，包含缓存写入；计价时普通输入＝输入－读取－写入。写入缺失时仅提供不完整参考额，不把缺失值当作零。
        </p>
        <ErrorBox error={info.error} />
        <div className="price-source">
          {info.data && (
            <>
              <a href={info.data.data.source} target="_blank" rel="noreferrer">
                官方 API 定价
              </a>
              <span>核对日期 {info.data.data.checkedAt}</span>
            </>
          )}
          <button
            type="button"
            className="text-button"
            disabled={!info.data}
            onClick={() => {
              keys.current = info.data!.data.prices.map(() => crypto.randomUUID());
              setReset((value) => value + 1);
              setDraft({ ...draft, modelPrices: info.data!.data.prices });
            }}
          >
            <RotateCcw size={14} />
            恢复官方预置
          </button>
        </div>
        <div ref={resetMotion}>
        <PresenceList key={reset} className="price-model-list" items={prices.map((price, index) => ({ price, index, id: keys.current[index] }))} itemKey={(row) => row.id}>
          {({ price: p, index, id }, _position, present) => (
            <fieldset className="price-model" data-model-row={id} disabled={!present}>
              <div className="price-model-name">
                <label>
                  模型 ID
                  <input
                    aria-label={`模型 ${index + 1} ID`}
                    value={p.model}
                    required
                    maxLength={160}
                    onChange={(e) => change(index, { model: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`移除模型 ${p.model}`}
                  onClick={() => {
                    focusNext.current = keys.current[index + 1] || keys.current[index - 1] || "add";
                    keys.current.splice(index, 1);
                    setDraft({
                      ...draft,
                      modelPrices: prices.filter((_, n) => n !== index),
                    });
                  }}
                >
                  <X size={16} />
                </button>
              </div>
              <div className="price-fields">
                {fields.map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <input
                      inputMode="decimal"
                      pattern="[0-9]{1,8}(\.[0-9]{1,6})?"
                      placeholder="未配置"
                      value={p[field] ?? ""}
                      onChange={(e) =>
                        change(index, { [field]: e.target.value || null })
                      }
                    />
                  </label>
                ))}
              </div>
              <MotionDetails form summary="长上下文价格">
                <label className="price-threshold">
                  单请求输入超过此 Token 数时应用
                  <input
                    type="number"
                    min={1}
                    placeholder="关闭长上下文分档"
                    value={p.longContextThreshold ?? ""}
                    onChange={(e) =>
                      change(index, {
                        longContextThreshold: e.target.value
                          ? Number(e.target.value)
                          : null,
                      })
                    }
                  />
                </label>
                <div className="price-fields">
                  {longFields.map(([field, label]) => (
                    <label key={field}>
                      {label}
                      <input
                        inputMode="decimal"
                        pattern="[0-9]{1,8}(\.[0-9]{1,6})?"
                        placeholder="未配置"
                        value={p[field] ?? ""}
                        onChange={(e) =>
                          change(index, { [field]: e.target.value || null })
                        }
                      />
                    </label>
                  ))}
                </div>
              </MotionDetails>
            </fieldset>
          )}
        </PresenceList>
        </div>
        <button
          ref={addButton}
          type="button"
          className="text-button"
          onClick={() => {
            const id = crypto.randomUUID();
            keys.current.push(id); focusNext.current = id;
            setDraft({
              ...draft,
              modelPrices: [
                ...prices,
                {
                  model: "",
                  input: null,
                  cachedInput: null,
                  cacheWrite: null,
                  output: null,
                  longContextThreshold: null,
                  longInput: null,
                  longCachedInput: null,
                  longCacheWrite: null,
                  longOutput: null,
                },
              ],
            });
          }}
        >
          <Plus size={15} />
          添加模型
        </button>
        <p className="footnote">
          空白表示未配置，0 表示明确免费。模型 ID
          精确匹配，不自动把未知模型或版本映射成其他模型。
        </p>
      </MotionDetails>
    </section>
  );
}
