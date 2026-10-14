import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, dateTime } from '../api';

interface Item { id: number; kind: string; message: string; link: string | null; createdAt: string; read: boolean }

/** The notification bell. Checks for new notifications every 30 seconds. */
export function Bell() {
  const [data, setData] = useState<{ unread: number; items: Item[] }>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  const load = () => api.get<typeof data>('/notifications').then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && data.unread > 0) {
      await api.post('/notifications/read-all');
      setData((d) => ({ ...d, unread: 0 }));
    }
  };

  return (
    <div className="bell" ref={ref}>
      <button className="bell-btn" aria-label={`Notifications, ${data.unread} unread`} onClick={toggle}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {data.unread > 0 && <span className="bell-count">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="bell-head">Notifications</div>
          {data.items.length === 0 && <p className="muted small" style={{ padding: 14 }}>Nothing yet.</p>}
          {data.items.map((n) => (
            <button key={n.id} className={`bell-item${n.read ? '' : ' unread'}`} onClick={() => { setOpen(false); if (n.link) nav(n.link); }}>
              <div>{n.message}</div>
              <div className="small muted">{dateTime(n.createdAt)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
