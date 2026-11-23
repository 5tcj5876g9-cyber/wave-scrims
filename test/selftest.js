// Self-test. Proves the queue, the split, the match maths and the ingest endpoint
// work without a Discord token. Every assertion prints the value it checked, so a
// failure names itself.

import { strict as assert } from 'node:assert';
import { createServer, request } from 'node:http';

import {
  loadState, createQueue, addPlayer, removePlayer, setTeams, getQueue,
  createMatch, applyMatchEvent, getMatch, setMessageRef, listMatches, EMPTY,
} from '../src/store.js';
import { splitRandom, splitBalanced, validate } from '../src/teams.js';
import { queueEmbed, resultsEmbed, dashboardEmbed, panelEmbed, panelButtons } from '../src/render.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL ${name} -> ${err.message}`);
  }
}
function section(t) { console.log(`\n${t}`); }

// ---------------------------------------------------------------- reset
// The state directory is swapped for a throwaway one before the first read, so a test
// run can never delete a live queue.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { setDataDir, dataDir } from '../src/store.js';

const TEST_DATA = join(tmpdir(), 'scrims-selftest-' + process.pid);
rmSync(TEST_DATA, { recursive: true, force: true });
setDataDir(TEST_DATA);
console.log(`state dir ${dataDir()}`);

const PLAYERS = [
  { discordId: '1001', tag: 'fwjamal', roblox: 'velithian' },
  { discordId: '1002', tag: 'pillow', roblox: 'datpillowfighterboi' },
  { discordId: '1003', tag: 'meem', roblox: 'TheMemeManipulator' },
  { discordId: '1004', tag: 'rizz', roblox: 'BIG_OLDPLAYER' },
  { discordId: '1005', tag: 'amoez', roblox: 'moez15323' },
  { discordId: '1006', tag: 'pstand', roblox: 'DrummerBoy589' },
  { discordId: '1007', tag: 'zarazora', roblox: 'liu5' },
  { discordId: '1008', tag: 'niop', roblox: 'niophbfh' },
  { discordId: '1009', tag: 'extra', roblox: 'should_not_fit' },
];

// ---------------------------------------------------------------- queue
section('QUEUE — capacity is enforced at 8');
const q = createQueue({ mode: 'flat', maxPlayers: 8, teamSize: 4, hostId: '9000', channelId: 'chan' });
check('queue starts empty and open', () => {
  assert.equal(q.players.length, 0);
  assert.equal(q.status, 'open');
});

for (const p of PLAYERS.slice(0, 8)) {
  const r = addPlayer(q.id, { ...p, role: 'player' });
  assert.equal(r.ok, true, 'add ' + p.tag);
}
check('8 players accepted', () => assert.equal(getQueue(q.id).players.length, 8));
check('queue flips to full at 8', () => assert.equal(getQueue(q.id).status, 'full'));

const overflow = addPlayer(q.id, { ...PLAYERS[8], role: 'player' });
check('9th player rejected', () => {
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason, /full/);
});

const dup = addPlayer(q.id, { ...PLAYERS[0], role: 'player' });
check('duplicate join rejected', () => {
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /already/);
});

check('leave reopens the queue', () => {
  const r = removePlayer(q.id, '1001');
  assert.equal(r.ok, true);
  assert.equal(getQueue(q.id).status, 'open');
  addPlayer(q.id, { ...PLAYERS[0], role: 'player' }); // put back
});

// ---------------------------------------------------------------- split
section('SPLIT — 4v4, no overlap');
const players = getQueue(q.id).players;
const teams = splitRandom(players, 4);
check('black has 4', () => assert.equal(teams.black.length, 4));
check('white has 4', () => assert.equal(teams.white.length, 4));
check('no player on both sides', () => {
  const ids = [...teams.black, ...teams.white].map((p) => p.discordId);
  assert.equal(new Set(ids).size, 8);
});
check('validate() reports nothing', () => {
  assert.deepEqual(validate(teams, 4), []);
});

const ratings = { velithian: 1500, datpillowfighterboi: 1400, themememanipulator: 1300, big_oldplayer: 1200, moez15323: 1100, drummerboy589: 1000, liu5: 900, niophbfh: 800 };
const bal = splitBalanced(players, 4, ratings);
check('balanced split is still 4v4', () => {
  assert.equal(bal.black.length, 4);
  assert.equal(bal.white.length, 4);
  assert.deepEqual(validate(bal, 4), []);
});
const sum = (arr) => arr.reduce((a, p) => a + (ratings[p.roblox.toLowerCase()] ?? 1000), 0);
check('balanced split is within 200 rating', () => {
  const diff = Math.abs(sum(bal.black) - sum(bal.white));
  assert.ok(diff <= 200, `rating gap ${diff} is too wide`);
});

teams.black[0].role = 'captain';
teams.white[0].role = 'captain';
setTeams(q.id, teams);
check('teams persisted', () => assert.equal(getQueue(q.id).teams.black.length, 4));

// ---------------------------------------------------------------- match
section('MATCH — events, score, K/D');
const match = createMatch({ queueId: q.id, mode: 'flat', teams, channelId: 'res' });
check('match starts live at 0-0', () => {
  assert.equal(match.status, 'live');
  assert.deepEqual(match.score, { black: 0, white: 0 });
});

const b0 = teams.black[0].roblox;
const w0 = teams.white[0].roblox;
for (let i = 0; i < 3; i++) applyMatchEvent(match.id, { type: 'kill', killer: b0, victim: w0 });
for (let i = 0; i < 1; i++) applyMatchEvent(match.id, { type: 'kill', killer: w0, victim: b0 });

const m1 = getMatch(match.id);
check('killer K/D recorded', () => {
  assert.equal(m1.stats[b0.toLowerCase()].kills, 3);
  assert.equal(m1.stats[b0.toLowerCase()].deaths, 1);
  assert.equal(m1.stats[w0.toLowerCase()].kills, 1);
  assert.equal(m1.stats[w0.toLowerCase()].deaths, 3);
});

applyMatchEvent(match.id, { type: 'score', side: 'black', value: 9 });
applyMatchEvent(match.id, { type: 'score', side: 'white', value: 11 });
check('score set from both sides', () => {
  const m = getMatch(match.id);
  assert.equal(m.score.black, 9);
  assert.equal(m.score.white, 11);
});

applyMatchEvent(match.id, { type: 'left', player: w0 });
check('left mid-match flagged', () => {
  assert.equal(getMatch(match.id).stats[w0.toLowerCase()].left, true);
});

applyMatchEvent(match.id, { type: 'end', side: 'white' });
check('match closes and names a winner', () => {
  const m = getMatch(match.id);
  assert.equal(m.status, 'done');
  assert.equal(m.winner, 'white');
});
check('events are append-only and counted', () => {
  // 3 kills + 1 kill + 2 scores + 1 left + 1 end = 8
  assert.equal(getMatch(match.id).events.length, 8);
});
check('a finished match rejects new events', () => {
  const r = applyMatchEvent(match.id, { type: 'kill', killer: b0, victim: w0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /done/);
});

// ---------------------------------------------------------------- embeds
section('RENDER — embeds build without a gateway');
check('queue embed builds', () => {
  const e = queueEmbed(getQueue(q.id), 'Flat scrims').toJSON();
  assert.ok(e.title === 'SCRIMS');
  assert.ok(e.fields.length >= 2);
});
check('dashboard embed builds with both teams', () => {
  const e = dashboardEmbed(getQueue(q.id), 'Flat scrims').toJSON();
  assert.equal(e.fields.length, 2);
  assert.match(e.fields[0].value, /velithian|TheMemeManipulator|BIG_OLDPLAYER|moez15323/);
});
check('results embed carries score, both sides and the winner', () => {
  const e = resultsEmbed(getMatch(match.id), 'Flat scrims').toJSON();
  assert.match(e.description, /White wins/i);
  const scoreField = e.fields.find((f) => f.name === 'BLACK');
  assert.equal(scoreField.value, '`9`');
  const whiteField = e.fields.find((f) => f.name === 'WHITE');
  assert.equal(whiteField.value, '`11`');
  const flat = JSON.stringify(e);
  assert.match(flat, /Left mid-match/);
  assert.match(flat, /velithian/);
  assert.match(flat, /DrummerBoy589/);
});

// ---------------------------------------------------------------- panel

section('PANEL — the dashboard control surface');
const panelCfg = {
  guildId: '1506550975605768312',
  channels: { results: '1574459084495912970' },
  modes: { flat: { label: 'Flat scrims', maxPlayers: 8, teamSize: 4 } },
  defaultMode: 'flat',
  links: { server: null },
};

check('panel embed reports the running lobby and match', () => {
  const e = panelEmbed({ queue: getQueue(q.id), match: getMatch(match.id), cfg: panelCfg }).toJSON();
  assert.equal(e.title, 'CONTROL');
  const lobby = e.fields.find((f) => f.name === 'LOBBY');
  const m = e.fields.find((f) => f.name === 'MATCH');
  assert.match(lobby.value, new RegExp(q.id));
  assert.match(m.value, new RegExp(match.id));
});

check('panel says "not set" when no server link exists', () => {
  const e = panelEmbed({ queue: null, match: null, cfg: panelCfg, server: null }).toJSON();
  assert.match(e.fields.find((f) => f.name === 'SERVER LINK').value, /not set/);
});

check('Join button is disabled without a link', () => {
  const rows = panelButtons({ queue: null, match: null, cfg: panelCfg, server: null }).map((r) => r.toJSON());
  const join = rows[0].components[0];
  assert.equal(join.disabled, true);
  assert.equal(join.url, undefined);
});

check('Join button becomes a link when the server link is set', () => {
  const url = 'https://www.roblox.com/games/11379739543/Timebomb-Duels?privateServerLinkCode=abc';
  const rows = panelButtons({ queue: null, match: null, cfg: panelCfg, server: url })
    .map((r) => r.toJSON());
  const join = rows[0].components[0];
  assert.equal(join.style, 5);
  assert.equal(join.url, url);
});

check('Split is disabled until the lobby is full', () => {
  const rows = panelButtons({ queue: { ...getQueue(q.id), players: [] }, match: null, cfg: panelCfg, server: null })
    .map((r) => r.toJSON());
  assert.equal(rows[1].components[0].disabled, true);
});

// This is the check that catches the shape Discord rejects at post time: a link
// button must carry a url and no custom_id, everything else must carry a custom_id.
check('every panel button is shaped the way discord requires', () => {
  const url = 'https://www.roblox.com/games/11379739543/Timebomb-Duels?privateServerLinkCode=abc';
  for (const server of [null, url]) {
    const rows = panelButtons({ queue: getQueue(q.id), match: getMatch(match.id), cfg: panelCfg, server })
      .map((r) => r.toJSON());
    for (const row of rows) {
      for (const c of row.components) {
        if (c.style === 5) {
          assert.ok(c.url, 'link button without a url');
          assert.equal(c.custom_id, undefined, 'link button must not carry a custom_id');
        } else {
          assert.ok(c.custom_id, `style ${c.style} button without a custom_id`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------- ingest over real HTTPsection('INGEST — a real POST from a real socket');

const m2 = createMatch({ queueId: q.id, mode: 'flat', teams, channelId: 'res' });
let refreshed = 0;

const { startIngest } = await import('../src/ingest.js');
const server = startIngest({
  cfg: { ingest: { enabled: true, host: '127.0.0.1', port: 8099, secret: 'test-secret-123' } },
  client: null,
  onEvent: () => { refreshed++; },
});

await new Promise((r) => setTimeout(r, 300));

function post(path, body, secret) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port: 8099, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(secret ? { 'X-Ingest-Secret': secret } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(out || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const noSecret = await post(`/ingest/${m2.id}`, { type: 'kill', killer: b0, victim: w0 }, null);
check('missing secret is refused', () => {
  assert.equal(noSecret.code, 401);
});

const wrongSecret = await post(`/ingest/${m2.id}`, { type: 'kill', killer: b0, victim: w0 }, 'nope');
check('wrong secret is refused', () => {
  assert.equal(wrongSecret.code, 401);
});

const batch = await post(`/ingest/${m2.id}`, [
  { type: 'kill', killer: b0, victim: w0 },
  { type: 'kill', killer: b0, victim: w0 },
  { type: 'score', side: 'black', value: 4 },
], 'test-secret-123');
check('valid batch accepted', () => {
  assert.equal(batch.code, 200);
  assert.equal(batch.body.accepted, 3);
  assert.equal(batch.body.rejected, 0);
});
check('batch actually wrote through to the match', () => {
  const m = getMatch(m2.id);
  assert.equal(m.stats[b0.toLowerCase()].kills, 2);
  assert.equal(m.score.black, 4);
});
check('board refreshed once per batch, not per event', () => {
  assert.equal(refreshed, 1);
});

const badMatch = await post('/ingest/m_doesnotexist', { type: 'kill' }, 'test-secret-123');
check('unknown match is 404', () => assert.equal(badMatch.code, 404));

const badType = await post(`/ingest/${m2.id}`, { nope: true }, 'test-secret-123');
check('event without a type is rejected, not crashed', () => {
  assert.equal(badType.code, 200);
  assert.equal(badType.body.rejected, 1);
});

server.close();

// ---------------------------------------------------------------- summary
console.log(`\n${'='.repeat(50)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
console.log('='.repeat(50));
process.exit(fail === 0 ? 0 : 1);
