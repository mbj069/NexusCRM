import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, put, del, qs, asArray } from '../api';
import {
  PageHeader, Card, Badge, Modal, EmptyState, Spinner, Alert, Field,
  pkr, areaStr, fmtDateTime, prettyLabel, BackLink, WaButton,
} from '../components/ui';
import DealModal from '../components/DealModal';
import { DocumentsPanel } from './Contacts';

const PROP_TYPES = ['plot', 'house', 'commercial_land', 'agriculture_land', 'shop', 'commercial_building'];
const PROP_STATUSES = ['Available', 'Booked', 'Sold', 'Blocked'];

function PropertyForm({ initial, onSaved, onCancel }) {
  const [f, setF] = useState({
    code: '', type: 'plot', title: '', location: '', areaValue: '', areaUnit: 'marla',
    price: '', listingType: 'sale', description: '',
    ...(initial || {}),
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [sellerContacts, setSellerContacts] = useState([]);
  const [sellerQ, setSellerQ] = useState(initial?.seller?.name || '');
  const [sellerId, setSellerId] = useState(initial?.sellerContactId || initial?.seller?.id || '');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const searchSellers = async (value) => {
    setSellerQ(value);
    if (value.trim().length < 2) return;
    try {
      setSellerContacts(asArray(await get('/api/contacts' + qs({ q: value.trim() }))));
    } catch { /* ignore */ }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!f.title.trim()) { setError('Title is required.'); return; }
    setSaving(true);
    try {
      const payload = { ...f };
      if (payload.areaValue === '') delete payload.areaValue; else payload.areaValue = Number(payload.areaValue);
      if (payload.price === '') delete payload.price; else payload.price = Number(payload.price);
      if (sellerId) payload.sellerContactId = sellerId;
      Object.keys(payload).forEach((k) => { if (payload[k] === '') delete payload[k]; });
      if (initial?.id) await put(`/api/properties/${initial.id}`, payload);
      else await post('/api/properties', payload);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="form-row">
        <Field label="Code" hint="e.g. DHA-P9-142"><input className="input" value={f.code} onChange={set('code')} /></Field>
        <Field label="Listing purpose">
          <select className="select" value={f.listingType || 'sale'} onChange={set('listingType')}>
            <option value="sale">🏷️ For Sale</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Type">
          <select className="select" value={f.type} onChange={set('type')}>
            {PROP_TYPES.map((t) => <option key={t} value={t}>{prettyLabel(t)}</option>)}
          </select>
        </Field>
        <Field label="Title *"><input className="input" value={f.title} onChange={set('title')} placeholder="e.g. 5 Marla Residential Plot" required /></Field>
      </div>
      <Field label="Location"><input className="input" value={f.location} onChange={set('location')} placeholder="e.g. DHA Phase 9, Lahore" /></Field>
      <div className="form-row">
        <Field label="Area value"><input className="input" type="number" min="0" step="any" value={f.areaValue} onChange={set('areaValue')} placeholder="e.g. 5" /></Field>
        <Field label="Area unit">
          <select className="select" value={f.areaUnit} onChange={set('areaUnit')}>
            <option value="marla">Marla</option>
            <option value="kanal">Kanal</option>
            <option value="sqft">Sq Ft</option>
          </select>
        </Field>
      </div>
      <Field label="Price (PKR)"><input className="input" type="number" min="0" value={f.price} onChange={set('price')} placeholder="e.g. 8500000" /></Field>
      <Field label="Owner / seller (contact)">
        <input
          className="input" list="seller-list" placeholder="Type to search contacts…"
          value={sellerQ}
          onChange={(e) => {
            searchSellers(e.target.value);
            const match = sellerContacts.find((c) => c.name === e.target.value);
            setSellerId(match ? String(match.id) : '');
          }}
        />
        <datalist id="seller-list">
          {sellerContacts.map((c) => <option key={c.id} value={c.name}>{c.phone || ''}</option>)}
        </datalist>
        <div className="hint">The person selling this property — shown on the property page.</div>
      </Field>
      <Field label="Description"><textarea className="textarea" value={f.description} onChange={set('description')} /></Field>
      {!initial?.id && (
        <div className="hint" style={{ marginBottom: 8 }}>
          Listed “For Sale” — the property goes straight into inventory as Available.
        </div>
      )}
      <div className="modal-foot">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : (initial?.id ? 'Save changes' : 'Add property')}</button>
      </div>
    </form>
  );
}

export function Inventory() {
  const [props, setProps] = useState([]);
  const [filters, setFilters] = useState({ type: '', location: '', minPrice: '', maxPrice: '', status: '', q: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = async (f = filters) => {
    setLoading(true);
    setError('');
    try {
      // Prefer the rich search endpoint; fall back to plain list.
      let list;
      try {
        list = await get('/api/properties/search' + qs({
          type: f.type, location: f.location, minPrice: f.minPrice,
          maxPrice: f.maxPrice, status: f.status, q: f.q,
        }));
      } catch {
        list = await get('/api/properties' + qs({ status: f.status, type: f.type, q: f.q }));
      }
      setProps(asArray(list));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load({ type: '', location: '', minPrice: '', maxPrice: '', status: '', q: '' }); }, []);

  const setF = (k) => (e) => setFilters((s) => ({ ...s, [k]: e.target.value }));
  const clear = () => {
    const empty = { type: '', location: '', minPrice: '', maxPrice: '', status: '', q: '' };
    setFilters(empty);
    load(empty);
  };

  return (
    <>
      <PageHeader
        title="Inventory"
        sub="Every plot, house and commercial unit you have on the books"
        actions={<button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Add property</button>}
      />

      <div className="filter-bar">
        <Field label="Type">
          <select className="select" value={filters.type} onChange={setF('type')}>
            <option value="">All</option>
            {PROP_TYPES.map((t) => <option key={t} value={t}>{prettyLabel(t)}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className="select" value={filters.status} onChange={setF('status')}>
            <option value="">All</option>
            {PROP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Location" hint="">
          <input className="input" placeholder="e.g. DHA, Johar Town" value={filters.location} onChange={setF('location')} />
        </Field>
        <Field label="Min price (PKR)"><input className="input" type="number" min="0" value={filters.minPrice} onChange={setF('minPrice')} /></Field>
        <Field label="Max price (PKR)"><input className="input" type="number" min="0" value={filters.maxPrice} onChange={setF('maxPrice')} /></Field>
        <Field label="Search" hint="">
          <input className="input" placeholder="Code, title…" value={filters.q}
            onChange={setF('q')}
            onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
        </Field>
        <button className="btn btn-secondary" onClick={() => load()}>Search</button>
        <button className="btn btn-ghost" onClick={clear}>Clear</button>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      {loading ? <Spinner /> : props.length === 0 ? (
        <Card><EmptyState icon="🏘️" title="No properties found" hint="Adjust the filters or add a new listing." /></Card>
      ) : (
        <div className="prop-grid">
          {props.map((p) => (
            <Link key={p.id} to={`/inventory/${p.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="prop-card" style={{ height: '100%' }}>
                <div className="prop-top">
                  <div>
                    <div className="prop-title">{p.title || p.code || `Property #${p.id}`}</div>
                    <div className="prop-loc">{p.location || '—'}{p.code ? ` · ${p.code}` : ''}</div>
                  </div>
                  <Badge status={p.status} />
                </div>
                <div className="prop-price">{p.price ? pkr(p.price) : 'Price on request'}</div>
                <div className="prop-meta">
                  <span>{prettyLabel(p.type)}</span>
                  <span>{areaStr(p.areaValue, p.areaUnit)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showNew && (
        <Modal title="Add property" onClose={() => setShowNew(false)} wide>
          <PropertyForm onCancel={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />
        </Modal>
      )}
    </>
  );
}

/* ================= Property detail ================= */

export function PropertyDetail() {
  const { id } = useParams();
  const [prop, setProp] = useState(null);
  const [txns, setTxns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [showDeal, setShowDeal] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [sellerContacts, setSellerContacts] = useState([]);
  const [sellerQ, setSellerQ] = useState('');
  const [sellerId, setSellerId] = useState('');
  const [sellerBusy, setSellerBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [p, t] = await Promise.all([
        get(`/api/properties/${id}`),
        get(`/api/properties/${id}/transactions`).catch(() => []),
      ]);
      setProp(p.property || p);
      // Transactions come wrapped as { property, deals, payments }.
      const tObj = t || {};
      const dealRows = asArray(tObj.deals).map((d) => ({
        id: `deal-${d.id}`, date: d.createdAt || d.created_at, type: 'deal',
        label: `Deal #${String(d.id).slice(0, 8)} · ${prettyLabel(d.stage)}`, amount: d.dealValue,
        link: `/deals/${d.id}`, linkLabel: 'Open deal →',
      }));
      const payRows = asArray(tObj.payments).map((pm) => ({
        id: `pay-${pm.id}`, date: pm.createdAt || pm.created_at, type: 'payment',
        label: `${prettyLabel(pm.method)}${pm.receiptNo ? ` · ${pm.receiptNo}` : ''}${pm.notes ? ` · ${pm.notes}` : ''}`,
        amount: pm.amount,
      }));
      setTxns([...dealRows, ...payRows].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const changeStatus = async (status) => {
    setStatusBusy(true);
    setNotice('');
    try {
      const res = await post(`/api/properties/${id}/status`, { status });
      setProp(res.property || res || { ...prop, status });
    } catch (e) {
      setNotice(e.message);
    } finally {
      setStatusBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete property "${prop.title || prop.code}"? This cannot be undone.`)) return;
    try {
      await del(`/api/properties/${id}`);
      window.history.back();
    } catch (e) {
      setNotice(e.message);
    }
  };

  const searchSellers = async (value) => {
    setSellerQ(value);
    if (value.trim().length < 2) return;
    try {
      setSellerContacts(asArray(await get('/api/contacts' + qs({ q: value.trim() }))));
    } catch { /* ignore */ }
  };

  const linkSeller = async () => {
    if (!sellerId) { setNotice('Pick a contact to link as owner/seller.'); return; }
    setSellerBusy(true);
    setNotice('');
    try {
      const res = await post(`/api/properties/${id}/seller`, { contactId: sellerId });
      setProp(res.property || res);
      setSellerQ(''); setSellerId('');
    } catch (e) {
      setNotice(e.message);
    } finally {
      setSellerBusy(false);
    }
  };

  const unlinkSeller = async () => {
    setSellerBusy(true);
    setNotice('');
    try {
      const res = await post(`/api/properties/${id}/seller`, { contactId: null });
      setProp(res.property || res);
    } catch (e) {
      setNotice(e.message);
    } finally {
      setSellerBusy(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return (<><BackLink to="/inventory" label="Inventory" /><Alert kind="error">{error}</Alert></>);
  if (!prop) return (<><BackLink to="/inventory" label="Inventory" /><Alert kind="error">Property not found.</Alert></>);

  return (
    <>
      <BackLink to="/inventory" label="Inventory" />
      <PageHeader
        title={prop.title || prop.code || `Property #${prop.id}`}
        sub={`${prop.location || '—'}${prop.code ? ` · ${prop.code}` : ''}`}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => setShowEdit(true)}>Edit</button>
            <button className="btn btn-ghost" style={{ color: 'var(--red-600)' }} onClick={remove}>Delete</button>
            <button
              className="btn btn-primary"
              onClick={() => setShowDeal(true)}
              disabled={String(prop.status).toLowerCase() !== 'available'}
              title={String(prop.status).toLowerCase() !== 'available' ? 'Only Available properties can be assigned to a deal' : 'Assign this property to a deal'}
            >
              🤝 Assign to deal
            </button>
          </>
        }
      />

      {notice && <Alert kind="error">{notice}</Alert>}

      <div className="grid grid-2">
        <Card title="Details">
          <dl className="kv">
            <dt>Status</dt><dd><Badge status={prop.status} /></dd>
            <dt>Type</dt><dd>{prettyLabel(prop.type)}</dd>
            <dt>Listing</dt><dd>{prop.listingType === 'sale' ? '🏷️ For Sale' : prettyLabel(prop.listingType || 'sale')}</dd>
            <dt>Location</dt><dd>{prop.location || '—'}</dd>
            <dt>Area</dt><dd>{areaStr(prop.areaValue, prop.areaUnit)}</dd>
            <dt>Price</dt><dd><strong>{prop.price ? pkr(prop.price) : 'Price on request'}</strong></dd>
            <dt>Description</dt><dd>{prop.description || '—'}</dd>
          </dl>
        </Card>

        <Card title="Owner / seller">
          {prop.seller ? (
            <>
              <dl className="kv">
                <dt>Name</dt><dd><Link to={`/contacts/${prop.seller.id}`}><strong>{prop.seller.name}</strong></Link></dd>
                <dt>Phone</dt><dd>{prop.seller.phone || '—'}</dd>
                <dt>WhatsApp</dt><dd>{prop.seller.whatsapp || prop.seller.phone || '—'}</dd>
                <dt>Email</dt><dd>{prop.seller.email || '—'}</dd>
                <dt>Type</dt><dd><Badge status={prop.seller.type || 'seller'} /></dd>
              </dl>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <WaButton phone={prop.seller.whatsapp || prop.seller.phone} name={prop.seller.name} className="btn btn-secondary btn-sm" />
                <button className="btn btn-ghost btn-sm" onClick={unlinkSeller} disabled={sellerBusy}>
                  {sellerBusy ? 'Unlinking…' : 'Unlink owner'}
                </button>
              </div>
            </>
          ) : (
            <>
              <EmptyState icon="👤" title="No owner linked" hint="Link the contact who owns or is selling this property." />
              <Field label="Link owner / seller">
                <input
                  className="input" list="detail-seller-list" placeholder="Type to search contacts…"
                  value={sellerQ}
                  onChange={(e) => {
                    searchSellers(e.target.value);
                    const match = sellerContacts.find((c) => c.name === e.target.value);
                    setSellerId(match ? String(match.id) : '');
                  }}
                />
                <datalist id="detail-seller-list">
                  {sellerContacts.map((c) => <option key={c.id} value={c.name}>{c.phone || ''}</option>)}
                </datalist>
              </Field>
              <button className="btn btn-primary btn-sm" onClick={linkSeller} disabled={sellerBusy || !sellerId}>
                {sellerBusy ? 'Linking…' : 'Link owner'}
              </button>
            </>
          )}
        </Card>

        <Card title="Change status">
          <p className="muted" style={{ marginTop: 0 }}>
            Booking or selling moves the unit out of the available pool.
          </p>
          <div className="stage-actions">
            {PROP_STATUSES.filter((s) => s !== prop.status).map((s) => (
              <button key={s} className="btn btn-secondary btn-sm" disabled={statusBusy} onClick={() => changeStatus(s)}>
                → {s}
              </button>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Transaction history" className="section-gap">
        {txns.length === 0 ? (
          <EmptyState icon="📜" title="No transactions yet" hint="Deals and payments on this property will appear here." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Type</th><th>Description</th><th className="num">Amount</th><th></th></tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(t.date)}</td>
                    <td><Badge status={t.type} /></td>
                    <td>{t.label || '—'}</td>
                    <td className="num">{t.amount ? pkr(t.amount) : '—'}</td>
                    <td>{t.link ? <Link to={t.link} className="btn btn-ghost btn-sm">{t.linkLabel}</Link> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Documents" className="section-gap">
        <DocumentsPanel entityType="property" entityId={prop.id} />
      </Card>

      {showEdit && (
        <Modal title="Edit property" onClose={() => setShowEdit(false)} wide>
          <PropertyForm initial={prop} onCancel={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); load(); }} />
        </Modal>
      )}
      {showDeal && <DealModal property={prop} onClose={() => setShowDeal(false)} />}
    </>
  );
}
