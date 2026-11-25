import Link from "next/link";

export default function Masthead({ consoleUrl }: { consoleUrl: string }) {
  return (
    <header className="pt-5 sm:pt-8">
      <div className="flex items-center justify-between gap-4 border-y border-ink py-3">
        <Link
          href="/"
          className="font-serif text-[23px] uppercase leading-none tracking-[0.14em] sm:text-[27px]"
        >
          Agent Depot
        </Link>
        <div className="flex shrink-0 items-center gap-4 sm:gap-6">
          <span className="stamp hidden sm:inline-block">Accepts TAB</span>
          <a href={consoleUrl} className="link-mono">
            TAB console ↗
          </a>
        </div>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line py-2">
        <span className="mono-label">The machine supply counter</span>
        <span className="mono-label">Price list no. 04 · Nov 2026</span>
        <span className="mono-label hidden sm:inline">Station 01 · Stellar testnet</span>
      </div>
    </header>
  );
}
