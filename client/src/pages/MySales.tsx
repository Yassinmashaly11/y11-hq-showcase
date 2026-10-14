import { useState } from 'react';
import { useApi } from '../hooks';
import { Loading, PageHead, SaleRow, SalesTable } from '../components/ui';
import { SaleForm } from '../components/SaleForm';

// The CEO's own sales (in person / WhatsApp), kept separate from the team's.
export function MySales() {
  const { data, error, reload } = useApi<SaleRow[]>('/sales');
  const [adding, setAdding] = useState(false);
  const mine = data?.filter((s) => s.channel === 'owner') ?? [];
  return (
    <>
      <PageHead title="My Sales" sub="Jerseys you sold yourself, in person or through WhatsApp. These are approved right away.">
        <button onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : '+ Add a sale'}</button>
      </PageHead>
      {adding && <SaleForm isOwner onDone={() => { setAdding(false); reload(); }} />}
      <div className="panel">
        {!data ? <Loading error={error} /> : <SalesTable sales={mine} showSeller={false} showProfit />}
      </div>
    </>
  );
}
