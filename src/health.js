// HTTP surface for hosting platforms.
//
// A free container host gives one public port and hits /health to decide whether the
// process is alive. Discord itself needs no inbound port - the gateway is outbound -
// so this server exists for two reasons: the health check, and the map bridge, which
// is mounted here so a single-port host still gets /ingest and /match.

import { createServer } from 'node:http';
import { listMatches, listQueues, currentQueue, latestMatch } from './store.js';
import { createIngestHandler } from './ingest.js';

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function startHealth({ client, cfg, onEvent, port = process.env.PORT ?? 8080 }) {
  const ingest = createIngestHandler({ cfg, onEvent });

  const server = createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/') {
      json(res, 200, {
        ok: true,
        uptime: Math.round(process.uptime()),
        bot: client?.user ? { id: client.user.id, tag: client.user.tag, ready: client.isReady() } : null,
        guild: cfg.guildId,
        queue: currentQueue()?.id ?? null,
        match: latestMatch()?.id ?? null,
        counts: { queues: listQueues().length, matches: listMatches().length },
        at: new Date().toISOString(),
      });
      return;
    }

    const handled = await ingest(req, res).catch((err) => {
      console.error('[http]', err.message);
      json(res, 500, { ok: false, error: 'internal' });
      return true;
    });
    if (!handled) json(res, 404, { ok: false, error: 'not found' });
  });

  server.listen(Number(port), '0.0.0.0', () => {
    console.log(`[health] listening on 0.0.0.0:${port} (/health, /ingest, /match)`);
  });
  server.on('error', (err) => console.error('[health]', err.message));
  return server;
}
