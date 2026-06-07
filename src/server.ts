import express, { Request, Response } from 'express';
import { PORT, DB_PATH, TENANT } from './constants.js';
import { errorPage } from './layout.js';
import { getData, renderMesh, renderMatrix } from './views/mesh.js';
import { renderTimeline } from './views/timeline.js';
import { renderLinks } from './views/links.js';
import { renderAgent } from './views/agent.js';
import { renderCurrent } from './views/current.js';
import { renderHealth } from './views/health.js';
import { renderCausalTree } from './views/causaltree.js';

export const app = express();

// ── /health ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

// ── SSE stub (full implementation in feat/live-feed) ──────────
// app.get('/sse/live', ...) — added in feat/live-feed

// ── Main route ────────────────────────────────────────────────
app.get('/', (req: Request, res: Response) => {
  const agent = req.query.agent as string | undefined;
  const rawView = req.query.view as string | undefined;
  const view = rawView ?? (agent ? 'agent' : 'mesh');
  const thread = req.query.thread as string | undefined;
  const range = (req.query.range as string) ?? '7d';
  const filterAgent = req.query.agent_filter as string | undefined;
  const filterFrom = req.query.from as string | undefined;
  const filterTo = req.query.to as string | undefined;

  try {
    let html: string;
    switch (view) {
      case 'mesh': {
        const data = getData();
        html = renderMesh(data);
        break;
      }
      case 'matrix': {
        const data = getData();
        html = renderMatrix(data);
        break;
      }
      case 'timeline':
        html = renderTimeline(range);
        break;
      case 'links':
        html = renderLinks();
        break;
      case 'agent':
        if (!agent) {
          res.redirect('/?view=mesh');
          return;
        }
        html = renderAgent(agent);
        break;
      case 'current':
        html = renderCurrent();
        break;
      case 'health':
        html = renderHealth();
        break;
      case 'causaltree':
        html = renderCausalTree(thread, filterAgent, filterFrom, filterTo);
        break;
      default:
        html = renderMesh(getData());
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
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
