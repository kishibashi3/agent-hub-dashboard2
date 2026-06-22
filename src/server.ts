import express, { Request, Response } from 'express';
import { PORT, DB_PATH, TENANT, resolveBasePath } from './constants.js';
import { errorPage } from './layout.js';
import { getData, renderMesh, renderMatrix } from './views/mesh.js';
import { renderTimeline } from './views/timeline.js';
import { renderLinks } from './views/links.js';
import { renderAgent } from './views/agent.js';
import { renderCurrent } from './views/current.js';
import { renderHealth } from './views/health.js';
import { renderCausalTree } from './views/causaltree.js';
import { renderLive, getLiveFeedData } from './views/live.js';
import { getDb, setThreadStatus, type ThreadStatus } from './db.js';

export const app = express();
app.use(express.json());

// ── /health ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

// ── POST /api/thread-status ────────────────────────────────────
// Persist an explicit thread status (running/done/stash) into the
// dashboard-owned DB. Mirrors v1's `?action=set_thread_status` handler.
app.post('/api/thread-status', (req: Request, res: Response) => {
  const { thread_id, status } = req.body as { thread_id?: string; status?: string };
  if (!thread_id || !['running', 'done', 'stash'].includes(status ?? '')) {
    res.status(400).json({ error: 'thread_id and status (running|done|stash) required' });
    return;
  }
  try {
    setThreadStatus(thread_id, TENANT ?? 'default', status as ThreadStatus);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── SSE /sse/live ──────────────────────────────────────────────
app.get('/sse/live', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let lastId = req.query.since as string | undefined;

  // Declare interval before send() so the error handler can clear it.
  let interval: ReturnType<typeof setInterval>;

  const send = () => {
    try {
      const db = getDb();
      const msgs = getLiveFeedData(db, lastId);
      db.close();
      if (msgs.length > 0) {
        lastId = msgs[0].created_at;
        res.write(`data: ${JSON.stringify(msgs)}\n\n`);
      } else {
        res.write(': heartbeat\n\n');
      }
    } catch {
      // DB failure: stop the interval and close the SSE connection so
      // the client reconnects instead of silently looping on errors.
      clearInterval(interval);
      res.end();
    }
  };

  send();
  interval = setInterval(send, 3000);
  req.on('close', () => clearInterval(interval));
});

// ── Main route ────────────────────────────────────────────────
app.get('/', async (req: Request, res: Response) => {
  const agent = req.query.agent as string | undefined;
  const rawView = req.query.view as string | undefined;
  const view = rawView ?? (agent ? 'agent' : 'mesh');
  const thread = req.query.thread as string | undefined;
  const range = (req.query.range as string) ?? '7d';
  const filterAgent = req.query.agent_filter as string | undefined;
  const filterFrom = req.query.from as string | undefined;
  const filterTo = req.query.to as string | undefined;

  // Resolve the deployment prefix per request (X-Forwarded-Prefix → BASE_PATH → '').
  const prefix = resolveBasePath(req.headers['x-forwarded-prefix']);

  try {
    // v1-faithful header stat: the `active links` count is computed ONCE here,
    // view-independent, and threaded into every view — mirroring v1
    // server.py:4221 `total_links_for_header = len(links)` (issue #29). The
    // canonical definition is mesh `getData().links` (undirected pairs, c>=3,
    // within top_set). Computing it per-view is what regressed it to 0.
    const meshData = getData();
    const totalLinks = meshData.links.length;

    let html: string;
    switch (view) {
      case 'mesh':
        html = renderMesh(meshData, prefix);
        break;
      case 'matrix':
        html = renderMatrix(meshData, prefix);
        break;
      case 'timeline':
        html = renderTimeline(range, prefix, totalLinks);
        break;
      case 'links':
        html = renderLinks(prefix, totalLinks);
        break;
      case 'agent':
        if (!agent) {
          res.redirect(`${prefix}/?view=mesh`);
          return;
        }
        html = renderAgent(agent, prefix, totalLinks);
        break;
      case 'current':
        html = renderCurrent(prefix, totalLinks);
        break;
      case 'health':
        html = renderHealth(prefix, totalLinks);
        break;
      case 'causaltree':
        html = await renderCausalTree(thread, filterAgent, filterFrom, filterTo, prefix, totalLinks);
        break;
      case 'live':
        html = renderLive(prefix, totalLinks);
        break;
      default:
        html = renderMesh(meshData, prefix);
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
