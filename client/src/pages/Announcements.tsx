import { FormEvent, useState } from 'react';
import { api, dateTime } from '../api';
import { useApi } from '../hooks';
import { useAuth } from '../App';
import { Loading, PageHead } from '../components/ui';

export interface Announcement { id: number; title: string; body: string; pinned: boolean; createdAt: string; author: string }

export function AnnouncementList({ items, onDelete }: { items: Announcement[]; onDelete?: (a: Announcement) => void }) {
  if (!items.length) return <p className="muted">No announcements yet.</p>;
  return (
    <div>
      {items.map((a) => (
        <div className="announcement" key={a.id}>
          <div className="actions" style={{ justifyContent: 'space-between' }}>
            <strong>{a.title}{a.pinned && <span className="badge" style={{ marginLeft: 8 }}>Pinned</span>}</strong>
            {onDelete && <button className="link small" onClick={() => onDelete(a)}>Delete</button>}
          </div>
          <p>{a.body}</p>
          <div className="small muted">{a.author} · {dateTime(a.createdAt)}</div>
        </div>
      ))}
    </div>
  );
}

export function Announcements() {
  const { user } = useAuth();
  const isOwner = user.role === 'owner';
  const { data, error, reload } = useApi<Announcement[]>('/announcements');
  const [f, setF] = useState({ title: '', body: '', pinned: false });
  const [err, setErr] = useState<string | null>(null);

  async function post(e: FormEvent) {
    e.preventDefault();
    try { await api.post('/announcements', f); setF({ title: '', body: '', pinned: false }); setErr(null); reload(); } catch (x: any) { setErr(x.message); }
  }
  const del = async (a: Announcement) => {
    if (!window.confirm(`Delete "${a.title}"?`)) return;
    await api.del(`/announcements/${a.id}`);
    reload();
  };

  return (
    <>
      <PageHead title="Announcements" sub={isOwner ? 'Messages to your whole team. Everyone gets a notification.' : 'Messages from Yassin.'} />
      {isOwner && (
        <form className="panel stack" onSubmit={post}>
          <label>Title<input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label>Message<textarea required rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
          <div className="actions">
            <button>Post to team</button>
            <label className="check"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top</label>
          </div>
          {err && <p className="error">{err}</p>}
        </form>
      )}
      <div className="panel">{!data ? <Loading error={error} /> : <AnnouncementList items={data} onDelete={isOwner ? del : undefined} />}</div>
    </>
  );
}
