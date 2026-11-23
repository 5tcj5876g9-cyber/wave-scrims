// Guild-scoped registration. Guild commands propagate in seconds instead of up to an
// hour, and a scrim bot is useless while it waits.

import './env.js';
import { REST, Routes } from 'discord.js';

import { buildCommands } from './commands.js';
import { loadConfig } from './config.js';

export async function deployCommands(cfg, token = process.env.DISCORD_TOKEN) {
  if (!token) throw new Error('DISCORD_TOKEN is not set');
  if (!cfg.guildId || cfg.guildId.startsWith('0000')) {
    throw new Error('guildId is not configured - run `npm run setup` first');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const me = await rest.get(Routes.user());
  const body = buildCommands(cfg);
  await rest.put(Routes.applicationGuildCommands(me.id, cfg.guildId), { body });
  return { commands: body.length, guildId: cfg.guildId, botId: me.id, tag: `${me.username}#${me.discriminator ?? '0'}` };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  try {
    const result = await deployCommands(loadConfig());
    console.log(`registered ${result.commands} commands in guild ${result.guildId} as ${result.tag}`);
  } catch (err) {
    console.error('registration failed:', err.message);
    process.exit(1);
  }
}
