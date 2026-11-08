// Vercel serverless entry point: re-export the Express app.
// Vercel invokes the default export as the function handler; the app's
// routes are mounted at /api/... and the vercel.json rewrite forwards
// /api/* here with the original URL preserved, so Express matches them.
// No app.listen() here — that is guarded off on Vercel in server/src/index.js.

import app from '../server/src/index.js';

export default app;
