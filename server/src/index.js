// NexusCRM server entry point.
//
// The Express app is exported for the Vercel serverless entry
// (api/index.js re-exports it). It only binds a port when running outside
// Vercel — `app.listen` is guarded on process.env.VERCEL.
//
// The schema is created at import time (top-level await) so cold starts
// always have the tables, including on first deploy against a fresh Turso
// database.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initSchema } from './db.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import contactsRouter from './routes/contacts.js';
import leadsRouter from './routes/leads.js';
import { activitiesRouter, followupsRouter } from './routes/activities.js';
import propertiesRouter from './routes/properties.js';
import dealsRouter from './routes/deals.js';
import plansRouter from './routes/plans.js';
import paymentsRouter, { receiptsRouter } from './routes/payments.js';
import ledgersRouter from './routes/ledgers.js';
import commissionsRouter from './routes/commissions.js';
import expensesRouter from './routes/expenses.js';
import documentsRouter from './routes/documents.js';
import aiRouter from './routes/ai.js';
import { webhookRouter, whatsappRouter } from './routes/whatsapp.js';
import dashboardRouter from './routes/dashboard.js';
import notificationsRouter from './routes/notifications.js';
import auditRouter from './routes/audit.js';

await initSchema();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
// Meta sends the webhook as JSON; urlencoded bodies are not used.
app.use(express.urlencoded({ extended: false }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'nexuscrm-server', time: new Date().toISOString() }));

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/activities', activitiesRouter);
app.use('/api/followups', followupsRouter);
app.use('/api/properties', propertiesRouter);
app.use('/api/deals', dealsRouter);
app.use('/api/plans', plansRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/receipts', receiptsRouter);
app.use('/api/ledgers', ledgersRouter);
app.use('/api/commissions', commissionsRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/webhooks/whatsapp', webhookRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/audit', auditRouter);

// 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Consistent error shape: { error: "message" }
 // eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 25 MB).' });
  }
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error.' });
});

const PORT = process.env.PORT || 4000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`nexuscrm-server listening on port ${PORT}`);
  });
}

export default app;
