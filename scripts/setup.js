// One command that wires the bot into the server.
//
//   npm run setup            # find the guild, create the channels, write config.json,
//                            # set the avatar, register the slash commands
//   npm run setup -- --guild 123456789012345678
//   npm run setup -- --no-avatar
//
// Everything it does is idempotent: run it twice and the second run finds what the
// first one made.

import './../src/env.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';

import { deployCommands } from '../src/deploy.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = join(ROOT, 'config.json');
const EXAMPLE = join(ROOT, 'config.example.json');
const AVATAR = join(ROOT, 'assets', 'wave.png');

// view, send, manage messages, embed links, attach files, read history, manage channels
const PERMISSIONS = 115968;

const CHANNELS = {
  queue: { name: 'scrims', topic: 'Wave scrim lobbies. Staff posts one with /host.' },
  dashboard: { name: 'scrim-dashboard', topic: 'Live team split, edited in place. Do not delete this message.' },
  results: { name: 'scrim-results', topic: 'Match boards, updated on every event.' },
  resultsLog: { name: 'scrim-log', topic: 'Reserved for the raw event trail.' },
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is missing. Put it in .env as DISCORD_TOKEN=...');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

function loadConfigFile() {
  const file = existsSync(CONFIG) ? CONFIG : EXAMPLE;
  return { file, cfg: JSON.parse(readFileSync(file, 'utf8')) };
}

// ---------------------------------------------------------------- guild

const me = await rest.get(Routes.user());
console.log(`bot      ${me.username} (${me.id})`);

const guilds = await rest.get('/users/@me/guilds');
let guild = null;

if (value('--guild')) {
  guild = guilds.find((g) => g.id === value('--guild')) ?? null;
  if (!guild) {
    console.error(`the bot is not in guild ${value('--guild')}`);
    console.error(`it is in: ${guilds.map((g) => `${g.name} (${g.id})`).join(', ') || 'nothing'}`);
    process.exit(2);
  }
} else if (guilds.length === 1) {
  guild = guilds[0];
} else if (guilds.length > 1) {
  const named = guilds.filter((g) => /wave/i.test(g.name));
  if (named.length === 1) guild = named[0];
  else {
    console.error('several guilds match; pass --guild <id>:');
    for (const g of guilds) console.error(`  ${g.id}  ${g.name}`);
    process.exit(2);
  }
}

if (!guild) {
  console.log('\nthe bot is not in any server yet. open this and pick the wave server:\n');
  console.log(`https://discord.com/api/oauth2/authorize?client_id=${me.id}&permissions=${PERMISSIONS}&scope=bot%20applications.commands`);
  console.log('\nthen run `npm run setup` again.');
  process.exit(3);
}

console.log(`guild    ${guild.name} (${guild.id})`);

// ---------------------------------------------------------------- channels

const existing = await rest.get(`/guilds/${guild.id}/channels`);
const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
const ids = {};

for (const [key, spec] of Object.entries(CHANNELS)) {
  const found = byName.get(spec.name);
  if (found && found.type === 0) {
    ids[key] = found.id;
    console.log(`channel  ${spec.name} exists`);
    continue;
  }
  try {
    const created = await rest.post(`/guilds/${guild.id}/channels`, {
      body: { name: spec.name, type: 0, topic: spec.topic },
    });
    ids[key] = created.id;
    console.log(`channel  ${spec.name} created`);
  } catch (err) {
    console.error(`channel  ${spec.name} could not be created: ${err.message}`);
    console.error('         the bot needs Manage Channels, or create it by hand and re-run');
    process.exit(4);
  }
}

// ---------------------------------------------------------------- config.json

const { cfg } = loadConfigFile();
cfg.guildId = guild.id;
cfg.channels = { ...cfg.channels, ...ids };
if (!cfg.roles) cfg.roles = { staff: '' };
if (!cfg.ingest?.secret || cfg.ingest.secret === 'CHANGE-ME-LONG-RANDOM-STRING') {
  cfg.ingest = cfg.ingest ?? {};
  cfg.ingest.secret = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
  console.log('secret   generated a new ingest secret');
}
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log(`config   written to ${CONFIG}`);

// ---------------------------------------------------------------- avatar

if (!flag('--no-avatar') && existsSync(AVATAR)) {
  try {
    const data = 'data:image/png;base64,' + readFileSync(AVATAR).toString('base64');
    await rest.patch(Routes.user(), { body: { avatar: data } });
    console.log('avatar   set from assets/wave.png');
  } catch (err) {
    console.error(`avatar   could not be set: ${err.message}`);
  }
}

// ---------------------------------------------------------------- commands

try {
  const result = await deployCommands(cfg, token);
  console.log(`commands ${result.commands} registered in ${guild.name}`);
} catch (err) {
  console.error('commands failed:', err.message);
  process.exit(5);
}

console.log('\nready. start it with: npm start');
console.log(`queue: /host in #${CHANNELS.queue.name} · dashboard: #${CHANNELS.dashboard.name} · results: #${CHANNELS.results.name}`);
