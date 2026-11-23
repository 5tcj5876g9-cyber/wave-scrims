// Prints what is actually in the server right now: every configured channel, its last
// board, the embed's brand fields, and the live bot presence. Read-only.
//
//   node scripts/status.js

import './../src/env.js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = join(ROOT, 'config.json');

if (!existsSync(CONFIG)) {
  console.error('config.json is missing - run `npm run setup`');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const me = await rest.get(Routes.user());
console.log(`bot     ${me.username}#${me.discriminator ?? '0'} (${me.id})`);
console.log(`avatar  ${me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : 'none'}`);

try {
  const member = await rest.get(`/guilds/${cfg.guildId}/members/${me.id}`);
  console.log(`status  ${member.user ? 'in the guild' : 'not cached'}`);
} catch {
  console.log('status  not in the guild');
}

const commands = await rest.get(Routes.applicationGuildCommands(me.id, cfg.guildId));
console.log(`cmds    ${commands.map((c) => '/' + c.name).join('  ')}`);

for (const [key, id] of Object.entries(cfg.channels)) {
  try {
    const channel = await rest.get(`/channels/${id}`);
    const msgs = await rest.get(`/channels/${id}/messages?limit=1`);
    const m = msgs[0];
    const e = m?.embeds?.[0];
    console.log(`\n#${channel.name}  (${key})`);
    if (!m) {
      console.log('   empty');
      continue;
    }
    console.log(`   last message ${m.id}  components=${m.components?.length ?? 0}`);
    if (e) {
      const color = '#' + (e.color ?? 0).toString(16).padStart(6, '0');
      console.log(`   embed  title=${e.title}  author=${e.author?.name}  icon=${e.author?.icon_url ? 'yes' : 'no'}`);
      console.log(`          color=${color}  fields=${e.fields?.length ?? 0}  footer=${e.footer?.text}`);
    }
  } catch (err) {
    console.log(`\n#${key} (${id})`);
    console.log(`   unreadable: ${err.message}`);
  }
}
