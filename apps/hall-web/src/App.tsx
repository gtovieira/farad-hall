// The app: signed out, the sign-in page; signed in, the frame and the screen of the path.
import { useAuth } from './auth.js';
import { useI18n } from './i18n.js';
import { Layout } from './Layout.js';
import { AlertsPage } from './pages/Alerts.js';
import { ClaimCodesPage } from './pages/ClaimCodes.js';
import { CustomerPage } from './pages/Customer.js';
import { CustomersPage } from './pages/Customers.js';
import { DevicePage } from './pages/Device.js';
import { FleetPage } from './pages/Fleet.js';
import { LoginPage } from './pages/Login.js';
import { match, usePath } from './router.js';
import { Empty } from './ui.js';

function Screen({ path }: { path: string }) {
  let m: Record<string, string> | null;
  if (path === '/') return <FleetPage />;
  if ((m = match('/devices/:id', path))) return <DevicePage id={m['id']!} />;
  if (path === '/alerts') return <AlertsPage />;
  if (path === '/customers') return <CustomersPage />;
  if ((m = match('/customers/:id', path))) return <CustomerPage id={m['id']!} />;
  if (path === '/claim-codes') return <ClaimCodesPage />;
  return <Empty title="404" />;
}

export function App() {
  const { me, loading } = useAuth();
  const { t } = useI18n();
  const path = usePath();
  if (loading) return <div className="login label">{t('app.loading')}</div>;
  if (!me) return <LoginPage />;
  return (
    <Layout active={path}>
      <Screen path={path} />
    </Layout>
  );
}
