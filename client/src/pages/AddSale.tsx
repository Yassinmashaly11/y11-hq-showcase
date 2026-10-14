import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHead } from '../components/ui';
import { SaleForm } from '../components/SaleForm';

export function AddSale() {
  const [done, setDone] = useState(false);
  // "Sold" on the Stock page opens this form with that jersey already picked: /add-sale?jersey=<size id>
  const [params] = useSearchParams();
  const preselect = Number(params.get('jersey')) || undefined;
  return (
    <>
      <PageHead title="Add Sale" sub="Log a jersey you sold in person or an order a customer paid for by e-Transfer." />
      {done && (
        <div className="alert good">
          Sale submitted. It shows as pending until Yassin approves it. {preselect && <Link to="/stock">Back to Stock</Link>}
        </div>
      )}
      <SaleForm key={preselect ?? 0} isOwner={false} preselect={preselect} onDone={() => setDone(true)} />
    </>
  );
}
