// End-to-end proof of the OCR route: a real Python process reads a real image and
// posts into a real listening socket, and this file checks what landed in the store.
//
// Run: node test/ocr-e2e.js        (needs python + winsdk + pillow, Windows only)

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createQueue, addPlayer, setTeams, createMatch, getMatch, setDataDir,
} from '../src/store.js';
import { startIngest } from '../src/ingest.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8101;
const SECRET = 'e2e-secret-do-not-use';

// Isolated state: a test run must never touch the live queues.
const TEST_DATA = join(tmpdir(), 'scrims-ocr-e2e-' + process.pid);
rmSync(TEST_DATA, { recursive: true, force: true });
setDataDir(TEST_DATA);

const ROSTER = [
  ['1001', 'fwjamal', 'velithian', 'black'],
  ['1002', 'pillow', 'datpillowfighterboi', 'black'],
  ['1003', 'meem', 'TheMemeManipulator', 'black'],
  ['1004', 'rizz', 'BIG_OLDPLAYER', 'black'],
  ['1005', 'amoez', 'moez15323', 'white'],
  ['1006', 'pstand', 'DrummerBoy589', 'white'],
  ['1007', 'zarazora', 'liu5', 'white'],
  ['1008', 'niop', 'niophbfh', 'white'],
];

const queue = createQueue({ mode: 'flat', maxPlayers: 8, teamSize: 4, hostId: '9000', channelId: 'chan' });
for (const [discordId, tag, roblox] of ROSTER) {
  const r = addPlayer(queue.id, { discordId, tag, roblox, role: 'player' });
  assert.equal(r.ok, true, 'seed ' + tag);
}

const teams = { black: [], white: [] };
for (const [discordId, tag, roblox, side] of ROSTER) {
  teams[side].push({ discordId, tag, roblox, role: 'player' });
}
setTeams(queue.id, teams);
const match = createMatch({ queueId: queue.id, mode: 'flat', teams, channelId: 'res' });

let refreshes = 0;
const server = startIngest({
  cfg: { ingest: { enabled: true, host: '127.0.0.1', port: PORT, secret: SECRET } },
  client: null,
  onEvent: () => { refreshes++; },
});

await new Promise((r) => setTimeout(r, 250));

// ---------------------------------------------------------------- run the bridge

const args = [
  join(ROOT, 'bridge', 'ocr-bridge.py'),
  '--match', match.id,
  '--url', `http://127.0.0.1:${PORT}`,
  '--secret', SECRET,
  '--image', join(ROOT, 'bridge', 'sample-scoreboard.png'),
  '--once', '--fresh',
];

const result = await new Promise((resolve) => {
  const child = spawn('python', ['-u', ...args], { cwd: ROOT, windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('close', (code) => resolve({ code, out }));
});

console.log('--- bridge output ---');
console.log(result.out.trim());
console.log('--- end bridge output ---\n');

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

check('bridge exited 0', () => assert.equal(result.code, 0, result.out));
check('bridge resolved 8 rows', () => assert.match(result.out, /8 rows @/));
check('bridge sent one event per player', () => assert.match(result.out, /sent 8/));

const m = getMatch(match.id);
check('every roster player has stats', () => {
  assert.equal(Object.keys(m.stats).length, 8);
});
check('kills/deaths match the image exactly', () => {
  const want = {
    velithian: [12, 5],
    datpillowfighterboi: [9, 7],
    themememanipulator: [11, 4],
    big_oldplayer: [6, 9],
    moez15323: [10, 8],
    drummerboy589: [7, 11],
    liu5: [5, 10],
    niophbfh: [8, 6],
  };
  for (const [name, [k, d]] of Object.entries(want)) {
    assert.equal(m.stats[name]?.kills, k, `${name} kills`);
    assert.equal(m.stats[name]?.deaths, d, `${name} deaths`);
  }
});
check('mangled OCR names were still attributed to the right player', () => {
  // The image renders "BIG_OLDPLAYER" with a space and "moez15323" as "moezl 5323".
  assert.ok(m.stats.big_oldplayer, 'BIG_OLDPLAYER not matched');
  assert.ok(m.stats.moez15323, 'moez15323 not matched');
});
check('board refreshed once for the batch', () => assert.equal(refreshes, 1));
check('no player was marked as left', () => {
  for (const st of Object.values(m.stats)) assert.equal(st.left, false);
});

// A second run with the same image must be silent: absolute values, no dupes.
const second = await new Promise((resolve) => {
  const child = spawn('python', ['-u', ...args.filter((a) => a !== '--fresh')], { cwd: ROOT, windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('close', (code) => resolve({ code, out }));
});
console.log(second.out.trim());
check('unchanged board produces no new events', () => assert.doesNotMatch(second.out, /sent [1-9]/));
check('kills did not double after the second scan', () => {
  assert.equal(getMatch(match.id).stats.velithian.kills, 12);
});

// ------------------------------------------------- a player is missing from the board

function runBridge(extra) {
  return new Promise((resolve) => {
    const child = spawn('python', ['-u', ...args.filter((a) => a !== '--fresh'), ...extra],
      { cwd: ROOT, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const partial = await runBridge([
  '--image', join(ROOT, 'bridge', 'sample-scoreboard-partial.png'),
  '--missing-scans', '1',
]);
console.log(partial.out.trim());
check('absent player is reported as left after the configured scans', () => {
  assert.match(partial.out, /niophbfh missing for 1 scans/);
  assert.equal(getMatch(match.id).stats.niophbfh.left, true);
});
check('only the disconnect was sent, not the whole board again', () => {
  assert.match(partial.out, /sent 1/);
});

const hidden = await runBridge([
  '--image', join(ROOT, 'bridge', 'sample-scoreboard-partial.png'),
  '--min-rows', '8',
]);
console.log(hidden.out.trim());
check('a half-visible board is skipped, not treated as seven disconnects', () => {
  assert.match(hidden.out, /board not visible, skipping/);
  assert.doesNotMatch(hidden.out, /sent [1-9]/);
});
check('the skip did not corrupt any counter', () => {
  const s = getMatch(match.id).stats;
  assert.equal(s.velithian.kills, 12);
  assert.equal(s.drummerboy589.kills, 7);
});

server.close();

console.log(`\n${'='.repeat(50)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
console.log('='.repeat(50));
process.exit(fail === 0 ? 0 : 1);
