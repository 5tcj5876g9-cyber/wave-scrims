// The bridge between a Roblox server and the Discord board.
//
// This is the part that answers "the map is not ours": nothing can read another
// place's live match, so something has to tell the bot. Three routes exist, all
// writing to the same endpoints:
//
//   1. roblox-http   a script inside the place POSTs every kill and round
//                    (bridge/roblox-script.lua) - needs a place you control
//   2. ocr           a companion on the host's PC reads the leaderboard off the
//                    screen and POSTs the numbers (bridge/ocr-bridge.py) - works on
//                    any map, needs the host's screen
//   3. manual        /result add|score|left|end - always available
//
// Both machine routes need two endpoints:
//   GET  /match/<matchId>    roster + current stats, secret-protected
//   POST /ingest/<matchId>   accepts one event or an array of them
//
// The handler is exported separately from the listener so a host that exposes a
// single port (every free platform) can mount it next to /health.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { getMatch, applyMatchEvent, saveState, loadState } from './store.js';

const MAX_BODY = 64 * 1024; // a kill event is ~120 bytes; 64 KB is generous and bounded

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
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

// Returns true when it handled the request, false when the path is not ours.
export function createIngestHandler({ cfg, onEvent }) {
  const secret = cfg.ingest.secret;

  return async function handle(req, res) {
    if (!req.url?.startsWith('/ingest/') && !req.url?.startsWith('/match/')) return false;

    if (req.method === 'GET' && req.url.startsWith('/match/')) {
      if (!checkSecret(req, secret)) {
        json(res, 401, { ok: false, error: 'bad secret' });
        return true;
      }
      const id = req.url.slice('/match/'.length).split('?')[0].split('/')[0];
      const m = getMatch(id);
      if (!m) {
        json(res, 404, { ok: false, error: 'no such match', matchId: id });
        return true;
      }
      json(res, 200, {
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
      return true;
    }

    if (req.method !== 'POST' || !req.url.startsWith('/ingest/')) {
      json(res, 404, { ok: false, error: 'not found' });
      return true;
    }

    if (!checkSecret(req, secret)) {
      json(res, 401, { ok: false, error: 'bad secret' });
      return true;
    }

    const matchId = req.url.slice('/ingest/'.length).split('?')[0];
    const match = getMatch(matchId);
    if (!match) {
      json(res, 404, { ok: false, error: 'no such match', matchId });
      return true;
    }
    if (match.status !== 'live') {
      json(res, 409, { ok: false, error: 'match is ' + match.status });
      return true;
    }

    let raw = '';
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        json(res, 413, { ok: false, error: 'body too large' });
        return true;
      }
      raw += chunk;
    }

    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      json(res, 400, { ok: false, error: 'body is not json' });
      return true;
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

    const after = getMatch(matchId);
    json(res, 200, {
      ok: true,
      accepted: accepted.length,
      rejected: rejected.length,
      detail: rejected.length ? rejected : undefined,
      match: { id: matchId, score: after.score, status: after.status },
    });
    return true;
  };
}

// Standalone listener, used locally and on any host that gives a second port.
export function startIngest({ cfg, client, onEvent, port, host }) {
  if (!cfg.ingest.enabled) {
    console.log('[ingest] disabled in config');
    return null;
  }
  const listenPort = Number(port ?? process.env.INGEST_PORT ?? cfg.ingest.port);
  const listenHost = host ?? cfg.ingest.host;
  const secret = cfg.ingest.secret;
  if (!secret || secret === 'CHANGE-ME-LONG-RANDOM-STRING') {
    console.warn('[ingest] secret is still the example value - set ingest.secret');
  }

  const handle = createIngestHandler({ cfg, onEvent });

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { ok: true, matches: Object.keys(loadState().matches).length, at: new Date().toISOString() });
      return;
    }
    const handled = await handle(req, res).catch((err) => {
      console.error('[ingest]', err.message);
      json(res, 500, { ok: false, error: 'internal' });
      return true;
    });
    if (!handled) json(res, 404, { ok: false, error: 'not found' });
  });

  server.listen(listenPort, listenHost, () => {
    console.log(`[ingest] listening on http://${listenHost}:${listenPort}  (POST /ingest/<matchId>)`);
  });
  server.on('error', (err) => console.error('[ingest]', err.message));
  return server;
}
