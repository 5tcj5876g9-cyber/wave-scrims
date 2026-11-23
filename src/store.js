// Persistent state. One JSON file, atomic writes, no database to install.
//
// Everything the bot needs to survive a restart lives here: open queues, the live
// match, and the message ids it must keep editing. A crash must not lose a queue,
// because the Join button on an old message stays clickable forever.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Tests must never touch the live state, so the directory is resolvable from the
// environment and swappable before the first read.
let DATA_DIR = process.env.SCRIMS_DATA_DIR
  ? resolve(process.env.SCRIMS_DATA_DIR)
  : join(ROOT, 'data');
let STATE_FILE = join(DATA_DIR, 'state.json');

export function dataDir() {
  return DATA_DIR;
}

export function setDataDir(dir) {
  DATA_DIR = resolve(dir);
  STATE_FILE = join(DATA_DIR, 'state.json');
  state = null;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

const EMPTY = {
  version: 1,
  queues: {},   // queueId -> queue
  matches: {},  // matchId -> match
  messages: {}, // key -> { channelId, messageId }
  settings: {}, // runtime values set from the panel, e.g. the private server link
};

let state = null;

export function loadState() {
  if (state) return state;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) {
    state = structuredClone(EMPTY);
    saveState();
    return state;
  }
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    // A corrupt state file must not stop the bot from starting. Keep the bad copy
    // instead of deleting it, because it may be the only record of an open queue.
    const salvage = STATE_FILE + '.corrupt-' + Date.now();
    try { renameSync(STATE_FILE, salvage); } catch { /* nothing else to do */ }
    console.error('[store] state was unreadable, moved to', salvage, '-', err.message);
    state = structuredClone(EMPTY);
    saveState();
    return state;
  }
  return state;
}

export function saveState() {
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, STATE_FILE);
}

export function newId(prefix) {
  return prefix + '_' + randomUUID().slice(0, 8);
}

// ---------------------------------------------------------------- queues

export function createQueue({ mode, maxPlayers, teamSize, hostId, channelId }) {
  const s = loadState();
  const id = newId('q');
  s.queues[id] = {
    id,
    mode,
    maxPlayers,
    teamSize,
    hostId,
    channelId,
    status: 'open',           // open | full | started | cancelled
    players: [],              // [{ discordId, tag, roblox, joinedAt }]
    teams: { black: [], white: [] },
    createdAt: Date.now(),
  };
  saveState();
  return s.queues[id];
}

export function getQueue(id) {
  return loadState().queues[id] ?? null;
}

export function listQueues(status) {
  const all = Object.values(loadState().queues);
  return status ? all.filter((q) => q.status === status) : all;
}

// The dashboard panel has no id in its buttons, so it always acts on "the lobby that
// is currently running" - newest open or full queue.
export function currentQueue() {
  const live = Object.values(loadState().queues).filter((q) => q.status === 'open' || q.status === 'full');
  return live.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export function latestMatch() {
  const live = Object.values(loadState().matches).filter((m) => m.status === 'live');
  return live.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

export function addPlayer(queueId, player) {
  const s = loadState();
  const q = s.queues[queueId];
  if (!q) return { ok: false, reason: 'no such queue' };
  // Duplicate is checked before capacity on purpose: someone re-clicking Join on a
  // full lobby should be told they are already in, not that there is no room.
  if (q.players.some((p) => p.discordId === player.discordId)) {
    return { ok: false, reason: 'already joined' };
  }
  if (q.players.length >= q.maxPlayers) {
    return { ok: false, reason: 'queue is full (' + q.maxPlayers + ')' };
  }
  if (q.status !== 'open') {
    return { ok: false, reason: 'queue is ' + q.status };
  }
  q.players.push({ ...player, joinedAt: Date.now() });
  if (q.players.length >= q.maxPlayers) q.status = 'full';
  saveState();
  return { ok: true, queue: q };
}

export function removePlayer(queueId, discordId) {
  const s = loadState();
  const q = s.queues[queueId];
  if (!q) return { ok: false, reason: 'no such queue' };
  const before = q.players.length;
  q.players = q.players.filter((p) => p.discordId !== discordId);
  if (q.players.length === before) return { ok: false, reason: 'not in queue' };
  if (q.status === 'full') q.status = 'open';
  saveState();
  return { ok: true, queue: q };
}

export function setTeams(queueId, teams) {
  const s = loadState();
  const q = s.queues[queueId];
  if (!q) return null;
  q.teams = teams;
  saveState();
  return q;
}

export function setQueueStatus(queueId, status) {
  const s = loadState();
  const q = s.queues[queueId];
  if (!q) return null;
  q.status = status;
  saveState();
  return q;
}

// ---------------------------------------------------------------- matches

export function createMatch({ queueId, mode, teams, channelId }) {
  const s = loadState();
  const id = newId('m');
  s.matches[id] = {
    id,
    queueId,
    mode,
    channelId,
    status: 'live',            // live | done | abandoned
    teams,                     // { black: [player], white: [player] }
    score: { black: 0, white: 0 },
    stats: {},                 // robloxNameLower -> { kills, deaths, left }
    events: [],                // append-only, for replay and for the audit trail
    source: null,              // 'roblox-http' | 'ocr' | 'manual'
    startedAt: Date.now(),
    endedAt: null,
  };
  saveState();
  return s.matches[id];
}

export function getMatch(id) {
  return loadState().matches[id] ?? null;
}

export function listMatches(status) {
  const all = Object.values(loadState().matches);
  return status ? all.filter((m) => m.status === status) : all;
}

export function applyMatchEvent(matchId, event) {
  const s = loadState();
  const m = s.matches[matchId];
  if (!m) return { ok: false, reason: 'no such match' };
  if (m.status !== 'live') return { ok: false, reason: 'match is ' + m.status };

  const ev = { ...event, at: Date.now() };
  m.events.push(ev);

  switch (ev.type) {
    case 'kill': {
      const k = normalise(ev.killer);
      const d = normalise(ev.victim);
      if (k) {
        m.stats[k] ??= { kills: 0, deaths: 0, left: false };
        m.stats[k].kills += 1;
      }
      if (d) {
        m.stats[d] ??= { kills: 0, deaths: 0, left: false };
        m.stats[d].deaths += 1;
      }
      break;
    }
    case 'score': {
      if (ev.side === 'black' || ev.side === 'white') {
        m.score[ev.side] = Number(ev.value) || 0;
      }
      break;
    }
    case 'left': {
      const n = normalise(ev.player);
      if (n) {
        m.stats[n] ??= { kills: 0, deaths: 0, left: false };
        m.stats[n].left = true;
      }
      break;
    }
    case 'stats': {
      // Absolute values, not deltas: the OCR bridge re-reads the whole board every
      // cycle, so a counter must never be added to. It can also misread a digit, so
      // a value that would walk backwards is ignored instead of trusted.
      const n = normalise(ev.player);
      if (n) {
        m.stats[n] ??= { kills: 0, deaths: 0, left: false };
        const k = Number(ev.kills);
        const d = Number(ev.deaths);
        if (Number.isFinite(k) && k > m.stats[n].kills) m.stats[n].kills = Math.min(k, 9999);
        if (Number.isFinite(d) && d > m.stats[n].deaths) m.stats[n].deaths = Math.min(d, 9999);
      }
      break;
    }
    case 'end': {
      if (ev.side === 'black' || ev.side === 'white') m.winner = ev.side;
      m.status = 'done';
      m.endedAt = Date.now();
      break;
    }
    default:
      // unknown events are kept in the log but change no counter
      break;
  }

  saveState();
  return { ok: true, match: m };
}

function normalise(name) {
  if (!name || typeof name !== 'string') return null;
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------- message refs

export function setMessageRef(key, channelId, messageId) {
  const s = loadState();
  s.messages[key] = { channelId, messageId };
  saveState();
}

// Small key/value store for things staff set at runtime (the private server link).
// It lives in state.json rather than config.json so a container with a read-only
// config still works and a redeploy keeps what the panel saved.
export function getSettings() {
  return loadState().settings ?? {};
}

export function setSetting(key, value) {
  const s = loadState();
  s.settings = s.settings ?? {};
  s.settings[key] = value;
  saveState();
  return s.settings;
}

export function getMessageRef(key) {
  return loadState().messages[key] ?? null;
}

export function clearMessageRef(key) {
  const s = loadState();
  delete s.messages[key];
  saveState();
}

export { EMPTY };
