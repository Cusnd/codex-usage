import type { ModelPrice, PricingInfo, Settings } from "../shared/contracts";
import { useData } from "./workspace";
import { ErrorBox } from "./ui";
import { X, Plus, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MotionDetails, PresenceList } from "./MotionPrimitives";
import { useReveal } from "./motion";

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
  const apiPricing = Boolean(draft.officialApiPricing);
  const catalog = apiPricing ? info.data?.data : info.data?.data.subscription;
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
          <label htmlFor="costEnabled">显示美元参考消耗 / 成本</label>
          <p>在摘要与明细中增加缓存写入和美元计价结果。默认关闭；开启后默认使用订阅模式。</p>
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
      <div className="setting-row">
        <div>
          <label htmlFor="officialApiPricing">使用官方 API 计价（API Key 用户勾选）</label>
          <p>按 Token 美元单价估算。已收录模型的订阅 Fast 为 2.5×，API 官方预置 Fast 为 2×；勾选后使用 API 计价规则。</p>
        </div>
        <input id="officialApiPricing" type="checkbox" checked={apiPricing}
          onChange={(e) => setDraft({ ...draft, officialApiPricing: e.target.checked })} />
      </div>
      <MotionDetails form open={open} onOpenChange={setOpen} duration={260} summary={<>
          模型参考单价 <span>USD / 百万 Token</span>
        </>}>
        <p className="footnote">
          {apiPricing
            ? "按官方 API 文本 Token 单价及 Fast 倍率估算；不计工具费用、Batch／Flex 或区域附加费。自定义价格保存后对历史记录重新估算。"
            : "按 Token 美元单价及订阅模式 Fast 倍率计算参考消耗，不代表订阅实际支出。费率表只读，API 自定义单价单独保留。"}
        </p>
        <p className="footnote">
          {apiPricing
            ? "非缓存输入＝输入－缓存读取，包含缓存写入；API 计价时普通输入＝输入－读取－写入。写入缺失时仅提供不完整参考额，不把缺失值当作零。"
            : "订阅计价区分非缓存输入、缓存读取与输出，非缓存输入包含缓存写入。Fast 使用相应倍率；无法识别档位或模型时保留未计价记录，不按 Standard 补算。"}
        </p>
        <ErrorBox error={info.error} />
        <div className="price-source">
          {catalog && (
            <>
              <a href={catalog.source} target="_blank" rel="noreferrer">
                {apiPricing ? "官方 API 定价" : "官方 Token 美元单价"}
              </a>
              <span>核对日期 {catalog.checkedAt}</span>
            </>
          )}
          {info.data && <a href={info.data.data.speedSource} target="_blank" rel="noreferrer">Fast 计价说明</a>}
          {apiPricing && <button
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
          </button>}
        </div>
        {!apiPricing && info.data?.data.subscription && <div className="subscription-price-scroll" tabIndex={0} role="region" aria-label="订阅模式美元参考单价表，可横向滚动">
          <table className="atlas-table subscription-prices">
            <thead><tr><th scope="col">模型</th><th scope="col" className="numeric">非缓存输入</th><th scope="col" className="numeric">缓存读取</th><th scope="col" className="numeric">输出</th><th scope="col" className="numeric">Fast 倍率</th></tr></thead>
            <tbody>{info.data.data.subscription.prices.map((price) => <tr key={price.model}>
              <th scope="row">{price.model}</th>
              {[price.input, price.cachedInput, price.output].map((value, index) => <td key={index} className="numeric">{value ?? "未配置"}</td>)}
              <td className="numeric">{price.fastMultiplier == null ? "未配置" : `${price.fastMultiplier}×`}</td>
            </tr>)}</tbody>
          </table>
          <p className="footnote">表内为 Standard 单价；Fast 单价＝对应单价 × Fast 倍率，单位均为 USD / 百万 Token。</p>
        </div>}
        {apiPricing && <>
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
              <label className="price-threshold">
                Fast 倍率（应用于该模型全部 API Token 单价）
                <input inputMode="decimal" pattern="[0-9]{1,8}(\.[0-9]{1,6})?" placeholder="未配置"
                  aria-label={`模型 ${p.model} Fast 倍率`}
                  value={(p.fastMultiplier === undefined ? info.data?.data.prices.find((price) => price.model === p.model)?.fastMultiplier : p.fastMultiplier) ?? ""}
                  onChange={(e) => change(index, { fastMultiplier: e.target.value || null })} />
              </label>
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
                  fastMultiplier: null,
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
        </>}
      </MotionDetails>
    </section>
  );
}
