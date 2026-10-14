import { useApi } from '../hooks';
import { dateTime, money } from '../api';
import { Loading, PageHead } from '../components/ui';
import { KIND_LABEL } from './Stock';

interface Entry { id: number; action: string; details: any; createdAt: string; actor: string }

const kind = (k: string) => (KIND_LABEL as Record<string, string>)[k]?.toLowerCase() ?? k;

const describe = (e: Entry, people: Record<number, string>): string => {
  const d = e.details ?? {};
  const who = (id: number) => people[id] ?? `associate #${id}`;
  switch (e.action) {
    case 'sale_created': return `Logged sale #${d.saleId} (${money(d.total ?? 0)})`;
    case 'sale_approved': return `Approved sale #${d.saleId}`;
    case 'sale_rejected': return `Rejected sale #${d.saleId}: ${d.reason}`;
    case 'payout_made': return `Paid ${who(d.associateId)} ${money(d.amount)} (statement #${d.payoutId})`;
    case 'in_hand_assigned': return `Gave out ${d.quantity} jersey(s) to ${who(d.associateId)}`;
    case 'in_hand_returned': return `Marked ${d.quantity} jersey(s) returned by ${who(d.associateId)}`;
    case 'jersey_update_requested': return `Reported ${d.jersey} as ${kind(d.kind)}`;
    case 'jersey_update_confirmed': return `Confirmed ${who(d.associateId)}'s ${d.jersey} as ${kind(d.kind)}${d.expense ? ` (${money(d.expense)} added to expenses)` : ''}`;
    case 'jersey_update_declined': return `Declined ${who(d.associateId)}'s update: ${d.jersey} ${kind(d.kind)}`;
    case 'website_order': return `Website order #${d.saleId}: ${d.jerseys} jersey(s), ${money(d.total ?? 0)}${d.associateId ? ` via ${who(d.associateId)}` : ''}`;
    case 'database_reset': return 'Database wiped and set up fresh (RESET_DATABASE on Railway)';
    case 'login_blocked': return `Locked "${d.username}" out for 15 minutes after 10 wrong passwords (from ${d.ip})`;
    case 'stock_request_made': return `Asked for ${d.jerseys}`;
    case 'stock_request_approved': return `Approved ${who(d.associateId)}'s request and handed over ${d.jerseys}`;
    case 'stock_request_declined': return `Declined ${who(d.associateId)}'s request for ${d.jerseys}`;
    case 'stock_set': return `Set stock to ${d.stock}`;
    case 'product_added': return `Added ${d.team} ${d.kit}`;
    case 'associate_added': return `Added associate ${d.name}`;
    case 'associate_removed': return `Removed ${who(d.associateId)}`;
    case 'associate_kept': return `Gave ${who(d.associateId)} another chance`;
    case 'cash_received': return `Received ${money(d.amount)} cash from ${who(d.associateId)}`;
    case 'level_check': return `2-month check: ${(d.events ?? []).map((x: any) => x.kind.replace(/_/g, ' ')).join(', ')} for ${who(d.associateId)}`;
    case 'promo_code_added': return `Added promo code ${d.code} for ${who(d.associateId)}`;
    case 'expense_added': return `Added expense: ${d.category} ${money(d.amount)}`;
    case 'expense_deleted': return `Deleted an expense`;
    case 'settings_changed': return `Changed settings`;
    case 'price_changed': return `Changed a jersey price`;
    case 'password_reset': return `Reset a password`;
    default: return e.action.replace(/_/g, ' ');
  }
};

export function ActivityLog() {
  const { data, error } = useApi<{ entries: Entry[]; people: Record<number, string> }>('/activity?limit=300');
  return (
    <>
      <PageHead title="Activity Log" sub="A permanent record of every change, so there's never a dispute about what happened." />
      <div className="panel">
        {!data ? <Loading error={error} /> : (
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>{data.entries.map((e) => <tr key={e.id}><td className="small">{dateTime(e.createdAt)}</td><td>{e.actor}</td><td>{describe(e, data.people)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
