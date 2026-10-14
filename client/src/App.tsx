import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api';
import { Bell } from './components/Bell';
import { Login } from './pages/Login';
import { OwnerDashboard } from './pages/OwnerDashboard';
import { Approvals } from './pages/Approvals';
import { Team } from './pages/Team';
import { Inventory } from './pages/Inventory';
import { Orders } from './pages/Orders';
import { MySales } from './pages/MySales';
import { Settings } from './pages/Settings';
import { AssociateHome } from './pages/AssociateHome';
import { AddSale } from './pages/AddSale';
import { ShiftTimer } from './pages/ShiftTimer';
import { Stock } from './pages/Stock';
import { AssociateSales } from './pages/AssociateSales';
import { Leaderboard } from './pages/Leaderboard';
import { Payouts, MyPayouts } from './pages/Payouts';
import { Announcements } from './pages/Announcements';
import { CodesLinks } from './pages/CodesLinks';
import { Expenses } from './pages/Expenses';
import { Customers } from './pages/Customers';
import { Reports } from './pages/Reports';
import { ActivityLog } from './pages/ActivityLog';

export interface User { id: number; role: 'owner' | 'associate'; name: string }

const AuthCtx = createContext<{ user: User; logout: () => void } | null>(null);
export const useAuth = () => useContext(AuthCtx)!;

type NavGroup = { title?: string; links: [string, string][] };

const OWNER_NAV: NavGroup[] = [
  { links: [['/', 'Dashboard'], ['/approvals', 'Pending Approvals']] },
  { title: 'Sales', links: [['/my-sales', 'My Sales'], ['/orders', 'Orders'], ['/customers', 'Customers']] },
  { title: 'Team', links: [['/team', 'Team'], ['/leaderboard', 'Leaderboard'], ['/payouts', 'Payouts'], ['/announcements', 'Announcements'], ['/links', 'Codes & Links']] },
  { title: 'Business', links: [['/inventory', 'Inventory'], ['/expenses', 'Expenses'], ['/reports', 'Reports'], ['/activity', 'Activity Log'], ['/settings', 'Settings']] },
];

const ASSOCIATE_NAV: NavGroup[] = [
  { links: [['/', 'My Dashboard'], ['/add-sale', 'Add Sale'], ['/sales', 'My Sales'], ['/shift', 'Shift Timer']] },
  { title: 'Team', links: [['/leaderboard', 'Leaderboard'], ['/payouts', 'My Payouts'], ['/links', 'My Codes & Link'], ['/announcements', 'Announcements']] },
  { links: [['/stock', 'Stock']] },
];

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [demo, setDemo] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    api.get<User>('/auth/me').then(setUser).catch(() => setUser(null));
    api.get<{ demoMode: boolean }>('/config').then((c) => setDemo(c.demoMode)).catch(() => {});
  }, []);

  if (user === undefined) return <div className="boot">Y11 HQ</div>;
  if (user === null) return <Login onLogin={setUser} />;

  const logout = async () => {
    await api.post('/auth/logout');
    setUser(null);
    nav('/');
  };
  const groups = user.role === 'owner' ? OWNER_NAV : ASSOCIATE_NAV;

  return (
    <AuthCtx.Provider value={{ user, logout }}>
      {demo && <div className="demo-bar">Demo with fake data. Click anything; it resets every night.</div>}
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="crest">Y11</span>
            <span className="brand-sub">HQ</span>
            <Bell />
          </div>
          <nav>
            {groups.map((g, i) => (
              <div key={i} className="nav-group">
                {g.title && <div className="nav-title">{g.title}</div>}
                {g.links.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
              </div>
            ))}
          </nav>
          <div className="who">
            <div className="who-name">{user.name}</div>
            <div className="who-role">{user.role === 'owner' ? 'CEO' : 'Sales associate'}</div>
            <button className="link" onClick={logout}>Log out</button>
          </div>
        </aside>
        <main className="content">
          {user.role === 'owner' ? (
            <Routes>
              <Route path="/" element={<OwnerDashboard />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/my-sales" element={<MySales />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/team" element={<Team />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/payouts" element={<Payouts />} />
              <Route path="/announcements" element={<Announcements />} />
              <Route path="/links" element={<CodesLinks />} />
              <Route path="/inventory" element={<Inventory />} />
              <Route path="/expenses" element={<Expenses />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/activity" element={<ActivityLog />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          ) : (
            <Routes>
              <Route path="/" element={<AssociateHome />} />
              <Route path="/add-sale" element={<AddSale />} />
              <Route path="/sales" element={<AssociateSales />} />
              <Route path="/shift" element={<ShiftTimer />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/payouts" element={<MyPayouts />} />
              <Route path="/links" element={<CodesLinks />} />
              <Route path="/announcements" element={<Announcements />} />
              <Route path="/stock" element={<Stock />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          )}
        </main>
      </div>
    </AuthCtx.Provider>
  );
}
