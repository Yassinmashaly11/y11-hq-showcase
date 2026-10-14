import { FormEvent, useState } from 'react';
import { api } from '../api';
import { useApi } from '../hooks';
import { useAuth } from '../App';
import { Loading, PageHead } from '../components/ui';

interface Code { id: number; code: string; active: boolean; associateId: number; associateName: string; uses: number }
interface Link { id: number; name: string; referralCode: string | null; url: string | null }

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-field">
      <code>{text}</code>
      <button className="secondary small" onClick={async () => { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function CodesLinks() {
  const { user } = useAuth();
  const isOwner = user.role === 'owner';
  const { data, error, reload } = useApi<{ codes: Code[]; links: Link[] }>('/promo-codes');
  const [f, setF] = useState({ associateId: 0, code: '' });
  const [err, setErr] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    try { await api.post('/promo-codes', { associateId: f.associateId || data!.links[0]?.id, code: f.code }); setF({ ...f, code: '' }); setErr(null); reload(); } catch (x: any) { setErr(x.message); }
  }
  const editLink = async (l: Link) => {
    const v = window.prompt(`Referral link name for ${l.name}`, l.referralCode ?? '');
    if (!v) return;
    try { await api.put(`/team/${l.id}/referral`, { referralCode: v }); reload(); } catch (x: any) { setErr(x.message); }
  };

  if (!data) return <Loading error={error} />;
  return (
    <>
      <PageHead title={isOwner ? 'Codes & Links' : 'My Codes & Link'}
        sub="Customers who use a code or buy through a link are credited to that associate. Codes only track; they don't give a discount. Website tracking switches on in Phase 3." />
      {isOwner && (
        <form className="panel" onSubmit={add}>
          <h2>New promo code</h2>
          <div className="form-row" style={{ alignItems: 'end', marginTop: 10 }}>
            <label>For<select value={f.associateId || data.links[0]?.id || 0} onChange={(e) => setF({ ...f, associateId: Number(e.target.value) })}>
              {data.links.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select></label>
            <label>Code<input required placeholder="e.g. YUSUF10" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></label>
            <button>Add code</button>
          </div>
          {err && <p className="error">{err}</p>}
        </form>
      )}
      <div className="panel">
        <h2>{isOwner ? 'Referral links' : 'My referral link'}</h2>
        <div className="stack" style={{ marginTop: 10 }}>
          {data.links.map((l) => (
            <div key={l.id}>
              {isOwner && <div className="actions" style={{ justifyContent: 'space-between', marginBottom: 4 }}><strong>{l.name}</strong><button className="link small" onClick={() => editLink(l)}>Change</button></div>}
              {l.url ? <Copy text={l.url} /> : <span className="muted">No link yet.</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <h2>{isOwner ? 'Promo codes' : 'My promo codes'}</h2>
        {data.codes.length === 0 ? <p className="muted">No codes yet.</p> : (
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Code</th>{isOwner && <th>Associate</th>}<th className="num">Orders</th><th>Status</th>{isOwner && <th />}</tr></thead>
            <tbody>
              {data.codes.map((c) => (
                <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
                  <td><strong>{c.code}</strong></td>{isOwner && <td>{c.associateName}</td>}
                  <td className="num">{c.uses}</td>
                  <td>{c.active ? <span className="badge good">Active</span> : <span className="badge">Off</span>}</td>
                  {isOwner && <td className="num"><button className="link small" onClick={async () => { await api.patch(`/promo-codes/${c.id}`, { active: !c.active }); reload(); }}>{c.active ? 'Turn off' : 'Turn on'}</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
