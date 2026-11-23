// Turns the bot's rooms private or public.
//
//   node scripts/channels.js --private    # create the staff role, hide all four rooms
//                                        # from @everyone, let staff and the bot in
//   node scripts/channels.js --public     # let @everyone see them again
//
// "Private" here means exactly that: nobody without the staff role can see the queue,
// the dashboard, the results or the log. The bot always keeps access, because it is
// the one posting.

import './../src/env.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = join(ROOT, 'config.json');
const STAFF_ROLE_NAME = 'Wave Staff';

const VIEW_CHANNEL = 1024n;
const mode = process.argv.includes('--public') ? 'public' : 'private';

if (!existsSync(CONFIG)) {
  console.error('config.json is missing - run `npm run setup` first');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
const me = await rest.get(Routes.user());

// ---------------------------------------------------------------- staff role

let staffRole = cfg.roles?.staff
  ? (await rest.get(`/guilds/${cfg.guildId}/roles`)).find((r) => r.id === cfg.roles.staff)
  : null;

if (!staffRole) {
  const roles = await rest.get(`/guilds/${cfg.guildId}/roles`);
  staffRole = roles.find((r) => r.name === STAFF_ROLE_NAME);
  if (!staffRole) {
    if (mode === 'public') {
      console.log(`no "${STAFF_ROLE_NAME}" role, nothing to unset`);
    } else {
      staffRole = await rest.post(`/guilds/${cfg.guildId}/roles`, {
        body: { name: STAFF_ROLE_NAME, color: 0x8fa3bf, mentionable: false, permissions: '0' },
      });
      console.log(`role created  ${STAFF_ROLE_NAME} (${staffRole.id})`);
    }
  }
}

if (staffRole) {
  cfg.roles = cfg.roles ?? {};
  cfg.roles.staff = staffRole.id;
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`staff role   ${staffRole.name} (${staffRole.id}) written to config.json`);
}

// ---------------------------------------------------------------- overwrites

const everyone = cfg.guildId;

for (const [key, channelId] of Object.entries(cfg.channels)) {
  try {
    if (mode === 'private') {
      await rest.put(`/channels/${channelId}/permissions/${everyone}`, {
        body: { type: 0, deny: String(VIEW_CHANNEL), allow: '0' },
      });
      if (staffRole) {
        await rest.put(`/channels/${channelId}/permissions/${staffRole.id}`, {
          body: { type: 0, allow: String(VIEW_CHANNEL), deny: '0' },
        });
      }
      await rest.put(`/channels/${channelId}/permissions/${me.id}`, {
        body: { type: 1, allow: String(VIEW_CHANNEL | 2048n | 16384n | 32768n | 65536n), deny: '0' },
      });
      console.log(`private      ${key}`);
    } else {
      await rest.put(`/channels/${channelId}/permissions/${everyone}`, {
        body: { type: 0, allow: String(VIEW_CHANNEL), deny: '0' },
      });
      console.log(`public       ${key}`);
    }
  } catch (err) {
    console.error(`${mode} failed on ${key} (${channelId}): ${err.message}`);
  }
}

console.log('\ndone. give the staff role to whoever runs scrims.');
