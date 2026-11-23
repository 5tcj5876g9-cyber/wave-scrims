// Posts one real lobby and one demo result board so the branding can be seen in the
// server without waiting for eight people. Everything it creates is real state: the
// lobby is joinable immediately, the demo board is labelled as demo in its content so
// it is obvious what to delete.
//
//   node scripts/demo.js            # lobby only
//   node scripts/demo.js --results  # lobby + a finished 4v4 board

import './../src/env.js';
import { Client, GatewayIntentBits, Events } from 'discord.js';

import { loadConfig, modeOf } from '../src/config.js';
import { createQueue, createMatch, applyMatchEvent, saveState } from '../src/store.js';
import { refreshBoard, refreshDashboard } from '../src/queue.js';
import { resultsEmbed, setBrandIcon } from '../src/render.js';

const cfg = loadConfig();
if (!cfg._ready) {
  console.error('config is not ready:', cfg._missing.join(', '));
  process.exit(1);
}

const withResults = process.argv.includes('--results');

const DEMO = [
  ['100000000000000001', 'fwjamal', 'velithian'],
  ['100000000000000002', 'pillow', 'datpillowfighterboi'],
  ['100000000000000003', 'meem', 'TheMemeManipulator'],
  ['100000000000000004', 'rizz', 'BIG_OLDPLAYER'],
  ['100000000000000005', 'amoez', 'moez15323'],
  ['100000000000000006', 'pstand', 'DrummerBoy589'],
  ['100000000000000007', 'zarazora', 'liu5'],
  ['100000000000000008', 'niop', 'niophbfh'],
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  try {
    setBrandIcon(c.user.displayAvatarURL({ size: 256, extension: 'png' }));
    const mode = cfg.defaultMode;
    const m = modeOf(cfg, mode);

    const queue = createQueue({
      mode,
      maxPlayers: m.maxPlayers,
      teamSize: m.teamSize,
      hostId: c.user.id,
      channelId: cfg.channels.queue,
    });

    // A fresh board always reads better with bodies on it, so the lobby opens with the
    // eight demo names already placed. Remove them with Leave before the real scrim.
    const { addPlayer } = await import('../src/store.js');
    for (const [discordId, tag, roblox] of DEMO) {
      addPlayer(queue.id, { discordId, tag, roblox, role: 'player' });
    }
    const { getQueue, setTeams } = await import('../src/store.js');
    const full = getQueue(queue.id);
    setTeams(queue.id, {
      black: full.players.slice(0, 4),
      white: full.players.slice(4, 8),
    });
    const ready = getQueue(queue.id);
    ready.teams.black[0].role = 'captain';
    ready.teams.white[0].role = 'captain';

    await refreshBoard(c, ready, cfg);
    await refreshDashboard(c, ready, cfg);
    console.log(`lobby    ${queue.id} posted in #${cfg.channels.queue}`);

    if (withResults) {
      const match = createMatch({ queueId: ready.id, mode, teams: ready.teams, channelId: cfg.channels.results });
      const b = ready.teams.black.map((p) => p.roblox);
      const w = ready.teams.white.map((p) => p.roblox);
      const kills = [12, 9, 11, 6, 8, 7, 5, 10];
      [...b, ...w].forEach((name, i) => {
        for (let k = 0; k < kills[i]; k++) {
          applyMatchEvent(match.id, {
            type: 'kill',
            killer: i < 4 ? name : w[i - 4],
            victim: i < 4 ? w[i % 4] : b[i % 4],
          });
        }
      });
      applyMatchEvent(match.id, { type: 'score', side: 'black', value: 9 });
      applyMatchEvent(match.id, { type: 'score', side: 'white', value: 11 });
      applyMatchEvent(match.id, { type: 'left', player: w[1] });
      applyMatchEvent(match.id, { type: 'end', side: 'white' });
      match.source = 'manual';
      saveState();

      const ch = await c.channels.fetch(cfg.channels.results);
      const label = modeOf(cfg, match.mode)?.label ?? match.mode;
      const msg = await ch.send({
        content: '`demo board` — delete this message when the real scrims start.',
        embeds: [resultsEmbed(match, label)],
      });
      console.log(`results  ${match.id} posted in #${cfg.channels.results} (${msg.id})`);
    }
  } catch (err) {
    console.error('demo failed:', err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

await client.login(process.env.DISCORD_TOKEN);
