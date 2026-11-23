// HTTP surface for hosting platforms.
//
// A free container host expects the process to listen on $PORT and answer a health
// check, otherwise it decides the service is dead and restarts it in a loop. The bot
// itself does not need HTTP - the Discord gateway is outbound - so this is a separate
// tiny server that reports the same state the panel shows.

import { createServer } from 'node:http';
import { listMatches, listQueues, currentQueue, latestMatch } from './store.js';

export function startHealth({ client, cfg, port = process.env.PORT ?? 8080 }) {
  const server = createServer((req, res) => {
    const body = req.url === '/health' || req.url === '/'
      ? {
        ok: true,
        uptime: Math.round(process.uptime()),
        bot: client?.user ? { id: client.user.id, tag: client.user.tag, ready: client.isReady() } : null,
        guild: cfg.guildId,
        queue: currentQueue()?.id ?? null,
        match: latestMatch()?.id ?? null,
        counts: { queues: listQueues().length, matches: listMatches().length },
        at: new Date().toISOString(),
      }
      : { ok: false, error: 'not found' };

    const payload = JSON.stringify(body);
    res.writeHead(body.ok ? 200 : 404, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  });

  server.listen(Number(port), '0.0.0.0', () => {
    console.log(`[health] listening on 0.0.0.0:${port} (/health)`);
  });
  server.on('error', (err) => console.error('[health]', err.message));
  return server;
}
