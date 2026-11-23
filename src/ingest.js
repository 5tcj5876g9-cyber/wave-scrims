// The bridge between the Roblox server and the Discord board.
//
// This is the part you asked about: the map is not yours, so the bot cannot read it.
// Three routes exist, in order of how much they cost and how much they give you:
//
//   1. roblox-http   You (or the map owner) drop one script into the place and it
//                    POSTs every kill and every round to this server. Full auto,
//                    zero latency, knows exactly which team is which. Costs: the
//                    place must run code you control, and the host needs to allow
//                    HTTP requests. This is how the board you screenshotted works.
//
//   2. ocr           A companion on the host's PC screenshots the scoreboard and
//                    POSTs the parsed numbers. Works on any map you do not own.
//                    Costs: a second process on the host, and it lags a few seconds.
//
//   3. manual        A referee presses /result add. Works everywhere, costs a human.
//
// All three write to the same endpoint, so the bot does not care which one is live
// and you can start on manual today and move to roblox-http without touching Discord.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { getMatch, applyMatchEvent, saveState, loadState } from './store.js';

const MAX_BODY = 64 * 1024; // a kill event is ~120 bytes; 64 KB is generous and bounded

export function startIngest({ cfg, client, onEvent }) {
  const { host, secret } = cfg.ingest;
  // Hosting platforms assign their own port; INGEST_PORT wins over config so the same
  // image runs locally and in a container.
  const port = Number(process.env.INGEST_PORT ?? cfg.ingest.port);
  if (!cfg.ingest.enabled) {
    console.log('[ingest] disabled in config');
    return null;
  }
  if (!secret || secret === 'CHANGE-ME-LONG-RANDOM-STRING') {
    console.warn('[ingest] secret is still the example value — set ingest.secret in config.json');
  }

  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    if (req.method === 'GET' && req.url === '/health') {
      const live = Object.keys(loadState().matches).length;
      return send(200, { ok: true, matches: live, at: new Date().toISOString() });
    }

    // The OCR bridge needs the roster before it can attribute a name it read off a
    // screen: OCR turns "moez15323" into "moezl 5323", so the exact spelling and the
    // side must come from the bot, not from the pixels.
    if (req.method === 'GET' && req.url.startsWith('/match/')) {
      if (!checkSecret(req, secret)) {
        return send(401, { ok: false, error: 'bad secret' });
      }
      const id = req.url.slice('/match/'.length).split('?')[0].split('/')[0];
      const m = getMatch(id);
      if (!m) return send(404, { ok: false, error: 'no such match', matchId: id });
      return send(200, {
        ok: true,
        match: {
          id: m.id,
          mode: m.mode,
          status: m.status,
          score: m.score,
          teams: { black: rosterOf(m.teams?.black), white: rosterOf(m.teams?.white) },
          stats: m.stats,
        },
      });
    }

    if (req.method !== 'POST' || !req.url.startsWith('/ingest/')) {
      return send(404, { ok: false, error: 'not found' });
    }

    if (!checkSecret(req, secret)) {
      return send(401, { ok: false, error: 'bad secret' });
    }

    const matchId = req.url.slice('/ingest/'.length).split('?')[0];
    const match = getMatch(matchId);
    if (!match) return send(404, { ok: false, error: 'no such match', matchId });
    if (match.status !== 'live') return send(409, { ok: false, error: 'match is ' + match.status });

    let raw = '';
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        return send(413, { ok: false, error: 'body too large' });
      }
      raw += chunk;
    }

    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      return send(400, { ok: false, error: 'body is not json' });
    }

    const events = Array.isArray(payload) ? payload : [payload];
    const accepted = [];
    const rejected = [];

    for (const ev of events) {
      if (!ev || typeof ev.type !== 'string') {
        rejected.push({ event: ev, reason: 'missing type' });
        continue;
      }
      const result = applyMatchEvent(matchId, ev);
      if (result.ok) accepted.push(ev.type);
      else rejected.push({ event: ev, reason: result.reason });
    }

    // One refresh per batch, not per event: a double kill must not cost two edits.
    if (accepted.length) {
      const fresh = getMatch(matchId);
      fresh.source = fresh.source ?? 'roblox-http';
      saveState();
      try {
        await onEvent?.(fresh);
      } catch (err) {
        console.error('[ingest] board refresh failed:', err.message);
      }
    }

    return send(200, {
      ok: true,
      accepted: accepted.length,
      rejected: rejected.length,
      detail: rejected.length ? rejected : undefined,
      match: { id: matchId, score: getMatch(matchId).score, status: getMatch(matchId).status },
    });
  });

  server.listen(port, host, () => {
    console.log(`[ingest] listening on http://${host}:${port}  (POST /ingest/<matchId>)`);
  });
  server.on('error', (err) => console.error('[ingest]', err.message));

  return server;
}

function rosterOf(players) {
  return (players ?? []).map((p) => ({
    roblox: p.roblox ?? null,
    tag: p.tag ?? null,
    role: p.role ?? 'player',
  }));
}

function checkSecret(req, secret) {
  if (!secret) return true;
  const got = req.headers['x-ingest-secret'];
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
