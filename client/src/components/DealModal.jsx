import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, qs, asArray } from '../api';
import { Modal, Field, Alert, pkr, Badge, EmptyState } from './ui';

/**
 * Create-deal modal. Used from the lead detail page (pick a property)
 * and from the property detail page (pick a lead; property is prefilled).
 * Surfaces 409 double-booking errors clearly.
 */
export default function DealModal({ lead, property, onClose }) {
  const navigate = useNavigate();
  const [leadId, setLeadId] = useState(lead?.id || '');
  const [propertyId, setPropertyId] = useState(property?.id || '');
  const [leads, setLeads] = useState([]);
  const [properties, setProperties] = useState([]);
  const [form, setForm] = useState({ dealValue: '', bayanaAmount: '', commissionType: 'percent', commissionValue: '' });
  const [commPick, setCommPick] = useState('');
  const [manualComm, setManualComm] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // The property being dealt on (prefilled, or picked from the list).
  const selectedProperty = property || properties.find((p) => p.id === propertyId) || null;
  const isRental = selectedProperty?.listingType === 'rent';
  const rentPerMonth = Number(selectedProperty?.rentPerMonth) || 0;

  useEffect(() => {
    (async () => {
      try {
        const [l, p] = await Promise.all([
          get('/api/leads' + qs({})).catch(() => []),
          get('/api/properties' + qs({ status: 'Available' })).catch(() => get('/api/properties')),
        ]);
        setLeads(asArray(l));
        setProperties(asArray(p));
      } catch (e) {
        setError('Could not load leads/inventory: ' + e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!leadId || !propertyId) {
      setError('Please select both a lead and a property.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        leadId,
        propertyId,
        notes: notes || undefined,
      };
      if (isRental) {
        // Deal value is the first month's rent (server takes it from the
        // property); bayana does not apply. Commission is a manual amount:
        // a half/full-month pick, or a free manual amount.
        if (manualComm !== '') payload.commissionAmount = Number(manualComm);
        else if (commPick) payload.commissionPick = commPick;
        else {
          setError('Pick a commission — half month, full month, or enter a manual amount.');
          setSaving(false);
          return;
        }
      } else {
        if (form.dealValue !== '') payload.dealValue = Number(form.dealValue);
        if (form.bayanaAmount !== '') payload.bayanaAmount = Number(form.bayanaAmount);
        if (form.commissionValue !== '') {
          payload.commissionType = form.commissionType;
          payload.commissionValue = Number(form.commissionValue);
        }
      }
      const deal = await post('/api/deals', payload);
      onClose();
      navigate(`/deals/${deal.id || deal.deal?.id || ''}`);
    } catch (err) {
      if (err.status === 409) {
        setError('Cannot create this deal: ' + err.message + ' The property may already be booked or sold — pick an Available property.');
      } else {
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Create Deal" onClose={onClose} wide>
      {error && <Alert kind="error">{error}</Alert>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : (
        <form onSubmit={submit}>
          <div className="form-row">
            <Field label="Lead">
              {lead ? (
                <div><strong>{lead.name}</strong> <Badge status={lead.stage} /></div>
              ) : (
                <select className="select" value={leadId} onChange={(e) => setLeadId(e.target.value)} required>
                  <option value="">— Select lead —</option>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.stage || 'new'}){l.budgetMax ? ` · up to ${pkr(l.budgetMax)}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Property">
              {property ? (
                <div>
                  <strong>{property.code || property.title}</strong>{' '}
                  <Badge status={property.status} />
                  <div className="muted">
                    {property.title} · {property.listingType === 'rent'
                      ? (property.rentPerMonth ? `${pkr(property.rentPerMonth)} / month` : 'For Rent')
                      : (property.price ? pkr(property.price) : '')}
                  </div>
                </div>
              ) : (
                <select className="select" value={propertyId} onChange={(e) => setPropertyId(e.target.value)} required>
                  <option value="">— Select available property —</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {(p.code ? p.code + ' · ' : '') + (p.title || '')} ({p.status})
                      {p.listingType === 'rent'
                        ? (p.rentPerMonth ? ` · ${pkr(p.rentPerMonth)} / month` : ' · For Rent')
                        : (p.price ? ` · ${pkr(p.price)}` : '')}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          {isRental ? (
            <>
              <div className="form-row">
                <Field label="First month's rent (deal value)">
                  <div style={{ padding: '8px 0' }}><strong>{rentPerMonth ? `${pkr(rentPerMonth)} / month` : '—'}</strong></div>
                  <div className="hint">Taken from the property — the deal value is the monthly rent. No bayana on rentals.</div>
                </Field>
              </div>
              <div className="form-row">
                <Field label="Commission — quick pick">
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className={`btn btn-sm ${commPick === 'half' && manualComm === '' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => { setCommPick('half'); setManualComm(''); }}>
                      Half month {rentPerMonth ? `(${pkr(rentPerMonth / 2)})` : ''}
                    </button>
                    <button type="button" className={`btn btn-sm ${commPick === 'full' && manualComm === '' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => { setCommPick('full'); setManualComm(''); }}>
                      Full month {rentPerMonth ? `(${pkr(rentPerMonth)})` : ''}
                    </button>
                  </div>
                </Field>
                <Field label="Or manual commission (PKR)">
                  <input
                    className="input" type="number" min="0" step="any"
                    value={manualComm} onChange={(e) => { setManualComm(e.target.value); if (e.target.value !== '') setCommPick(''); }}
                    placeholder="e.g. 15000"
                  />
                </Field>
              </div>
            </>
          ) : (
            <>
              <div className="form-row">
                <Field label="Deal value (PKR)">
                  <input className="input" type="number" min="0" value={form.dealValue} onChange={set('dealValue')} placeholder="e.g. 8500000" />
                </Field>
                <Field label="Bayana / token money (PKR)">
                  <input className="input" type="number" min="0" value={form.bayanaAmount} onChange={set('bayanaAmount')} placeholder="e.g. 500000" />
                </Field>
              </div>

              <div className="form-row">
                <Field label="Commission type">
                  <select className="select" value={form.commissionType} onChange={set('commissionType')}>
                    <option value="percent">Percent of deal value</option>
                    <option value="fixed">Fixed amount (PKR)</option>
                  </select>
                </Field>
                <Field label="Commission value">
                  <input
                    className="input" type="number" min="0" step="any"
                    value={form.commissionValue} onChange={set('commissionValue')}
                    placeholder={form.commissionType === 'percent' ? 'e.g. 2' : 'e.g. 100000'}
                  />
                </Field>
              </div>
            </>
          )}

          <Field label="Notes">
            <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the agent should know…" />
          </Field>

          {!lead && !property && leads.length === 0 && properties.length === 0 && (
            <EmptyState icon="🤝" title="Nothing to deal with yet" hint="Add a lead and list an available property first." />
          )}

          <div className="modal-foot">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create deal'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
