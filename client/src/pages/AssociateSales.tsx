import { useApi } from '../hooks';
import { Loading, PageHead, SaleRow, SalesTable } from '../components/ui';

export function AssociateSales() {
  const { data, error } = useApi<SaleRow[]>('/sales');
  return (
    <>
      <PageHead title="My Sales" sub="Every sale you've logged and whether it's approved." />
      <div className="panel">{!data ? <Loading error={error} /> : <SalesTable sales={data} showSeller={false} />}</div>
    </>
  );
}
