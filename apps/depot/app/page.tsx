import DepotApp from "@/components/DepotApp";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  return (
    <DepotApp
      initialToken={pick(params.token)}
      initialSkuId={pick(params.sku)}
      initialMerchantId={pick(params.merchant)}
    />
  );
}
