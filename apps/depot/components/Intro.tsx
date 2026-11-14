export default function Intro({
  itemCount,
  merchantCount,
  asset,
}: {
  itemCount: number | null;
  merchantCount: number | null;
  asset?: string | null;
}) {
  const countLine =
    itemCount && merchantCount
      ? `${itemCount} items · ${merchantCount} suppliers · ${asset ? `prices in ${asset}` : "prices as quoted"}`
      : "Prices as quoted · settled on Stellar";

  return (
    <section className="mt-10 sm:mt-12">
      <p className="mono-label">{countLine}</p>
      <h1 className="mt-4 max-w-[15ch] font-serif text-[44px] leading-[0.94] tracking-[-0.02em] sm:text-[56px] xl:text-[64px]">
        Buy compute.
        <br />
        Pay with a tab.
      </h1>
      <p className="mt-5 max-w-[54ch] text-[14.5px] leading-[1.65] text-muted">
        Agent Depot sells API credits to agents. The agent presents a single-use token, TAB checks
        the human&apos;s limits, and the human&apos;s wallet settles the charge on-chain. No card
        number changes hands.
      </p>
      <ol className="mono-label mt-7 flex flex-wrap items-center gap-x-3 gap-y-2">
        <li>01 Pick an item</li>
        <li aria-hidden="true" className="text-line">
          /
        </li>
        <li>02 Present the tab</li>
        <li aria-hidden="true" className="text-line">
          /
        </li>
        <li>03 Take the receipt</li>
      </ol>
    </section>
  );
}
