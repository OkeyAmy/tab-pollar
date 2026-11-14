import type { CSSProperties } from "react";
import type { CatalogSku, CatalogueGroup } from "@/lib/catalogue";
import { money, pad2 } from "@/lib/format";

type CatalogueListProps = {
  groups: CatalogueGroup[];
  selectedSkuId: string | null;
  busy: boolean;
  onChoose: (skuId: string) => void;
  onRetry: () => void;
};

export default function CatalogueList({
  groups,
  selectedSkuId,
  busy,
  onChoose,
  onRetry,
}: CatalogueListProps) {
  if (groups.length === 0) {
    return (
      <div className="mt-12 border-t border-line pt-8">
        <p className="mono-label text-muted">The price list is empty</p>
        <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed">
          Seed the database, then reload. The till has nothing to sell until the merchants arrive.
        </p>
        <button type="button" onClick={onRetry} className="link-mono mt-4 inline-block">
          Reload the price list
        </button>
      </div>
    );
  }

  return (
    <div className="mt-11 space-y-12">
      {groups.map(({ merchant, skus }) => (
        <section key={merchant.id} aria-labelledby={`merchant-${merchant.id}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b-2 border-ink pb-2">
            <h2
              id={`merchant-${merchant.id}`}
              className="font-serif text-[29px] leading-none sm:text-[33px]"
            >
              {merchant.name}
            </h2>
            <p className="mono-label">
              {merchant.category} · {merchant.domain}
            </p>
          </div>
          <ul>
            {skus.map((sku, index) => (
              <SkuRow
                key={sku.id}
                sku={sku}
                asset={sku.asset ?? merchant.asset ?? null}
                index={index}
                selected={sku.id === selectedSkuId}
                busy={busy}
                onChoose={onChoose}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SkuRow({
  sku,
  asset,
  index,
  selected,
  busy,
  onChoose,
}: {
  sku: CatalogSku;
  asset: string | null;
  index: number;
  selected: boolean;
  busy: boolean;
  onChoose: (skuId: string) => void;
}) {
  return (
    <li
      className="row-in border-b border-line"
      style={{ "--i": index } as CSSProperties}
    >
      <div className="grid grid-cols-[1.6rem_minmax(0,1fr)] gap-x-3 py-6 sm:grid-cols-[1.9rem_minmax(0,1fr)_auto] sm:gap-x-5">
        <span className="mono-label pt-2 text-muted">{pad2(index + 1)}</span>

        <div>
          <h3 className="font-serif text-[23px] leading-[1.04] sm:text-[26px]">{sku.name}</h3>
          <p className="mt-2 max-w-[52ch] text-[13px] leading-[1.6] text-muted">
            {sku.description}
          </p>
          <p className="mono-label mt-2.5">
            {sku.unit} · one key · delivered on settlement
          </p>
        </div>

        <div className="col-start-2 mt-3 flex items-baseline justify-between gap-4 sm:col-start-3 sm:mt-0 sm:min-w-[9.5rem] sm:flex-col sm:items-end sm:gap-2 sm:pt-1">
          <span className="font-mono text-[17px] leading-none tnum sm:text-[18px]">
            {money(sku.price, asset)}
          </span>
          <div className="flex items-center gap-2">
            {selected ? (
              <span className="mono-label bg-acid px-1 py-0.5">On the slip</span>
            ) : null}
            <button
              type="button"
              onClick={() => onChoose(sku.id)}
              disabled={busy}
              aria-label={`Buy ${sku.name} with a tab`}
              className="-mx-1 border-b border-ink px-1 pb-0.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors hover:bg-acid disabled:border-line disabled:text-muted disabled:hover:bg-transparent active:translate-y-px"
            >
              Buy with a tab
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}
