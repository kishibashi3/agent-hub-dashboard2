import express, { Request, Response } from 'express';
import { PORT } from './constants.js';
import { DB_PATH, TENANT } from './constants.js';
import { errorPage } from './layout.js';

export const app = express();

// ── /health ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

// ── SSE stub (full implementation in feat/live-feed) ──────────
// app.get('/sse/live', ...) — added in feat/live-feed

// ── Main route stub (views wired in feat/inherited-views) ─────
app.get('/', (req: Request, res: Response) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<html><body><h1>agent-hub dashboard v2</h1><p>Views loading...</p></body></html>');
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error('Dashboard error:', msg);
    res.status(500).send(errorPage(msg));
  }
});

app.listen(PORT, () => {
  console.log(`agent-hub dashboard v2 listening on http://0.0.0.0:${PORT}`);
  console.log(`  DB: ${DB_PATH}`);
  console.log(`  Tenant: ${TENANT ?? '(all)'}`);
});
