import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Alert, Field } from '../components/ui';

export default function Login() {
  const { user, loading, login, changePassword } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [forceChange, setForceChange] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');

  if (!loading && user && !user.mustChangePassword) {
    return <Navigate to="/" replace />;
  }

  const doLogin = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const u = await login(username.trim(), password);
      if (u.mustChangePassword) {
        setForceChange(true);
        setCurrentPw(password);
      } else {
        navigate('/', { replace: true });
      }
    } catch (err) {
      setError(err.message || 'Login failed. Check your username and password.');
    } finally {
      setBusy(false);
    }
  };

  const doChange = async (e) => {
    e.preventDefault();
    setError('');
    if (newPw.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPw !== confirmPw) {
      setError('New passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPw, newPw);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || 'Password change failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark">N</div>
          <div>
            <h1>NexusCRM</h1>
            <p>Property Dealer CRM</p>
          </div>
        </div>

        {error && <Alert kind="error">{error}</Alert>}

        {forceChange ? (
          <>
            <h2 style={{ fontSize: 16, margin: '0 0 6px' }}>Set a new password</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Your account requires a password change before you can continue.
            </p>
            <form onSubmit={doChange}>
              <Field label="New password">
                <input
                  className="input" type="password" value={newPw}
                  onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" required
                />
              </Field>
              <Field label="Confirm new password">
                <input
                  className="input" type="password" value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required
                />
              </Field>
              <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
                {busy ? 'Updating…' : 'Update password & continue'}
              </button>
            </form>
          </>
        ) : (
          <form onSubmit={doLogin}>
            <Field label="Username">
              <input
                className="input" value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username" placeholder="e.g. admin@nexuscrm.local" required
              />
            </Field>
            <Field label="Password">
              <input
                className="input" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" required
              />
            </Field>
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
