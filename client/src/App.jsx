import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { Leads, LeadDetail } from './pages/Leads.jsx';
import { Contacts, ContactDetail } from './pages/Contacts.jsx';
import { Inventory, PropertyDetail } from './pages/Inventory.jsx';
import { Deals, DealDetail } from './pages/Deals.jsx';
import { Payments, PlanDetail, LedgerView } from './pages/Payments.jsx';
import Commissions from './pages/Commissions.jsx';
import Followups from './pages/Followups.jsx';
import Settings from './pages/Settings.jsx';

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword) return <Navigate to="/login" replace />;
  return children;
}

function SettingsGate({ children }) {
  const { user } = useAuth();
  if (user?.role !== 'admin' && user?.role !== 'manager') return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="leads" element={<Leads />} />
        <Route path="leads/:id" element={<LeadDetail />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="contacts/:id" element={<ContactDetail />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="inventory/:id" element={<PropertyDetail />} />
        <Route path="deals" element={<Deals />} />
        <Route path="deals/:id" element={<DealDetail />} />
        <Route path="payments" element={<Payments />} />
        <Route path="payments/plans/:id" element={<PlanDetail />} />
        <Route path="payments/ledgers/:contactId" element={<LedgerView />} />
        <Route path="commissions" element={<Commissions />} />
        <Route path="followups" element={<Followups />} />
        <Route
          path="settings"
          element={
            <SettingsGate>
              <Settings />
            </SettingsGate>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
