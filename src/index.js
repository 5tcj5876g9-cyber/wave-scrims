// Entry point.
//
// Responsibilities, in order: load config, refuse to run half-configured, register
// the interaction router, open the ingest server, restore any queue that was open
// when the process died. Nothing here holds state that is not also on disk.

import './env.js';
import {
  Client, GatewayIntentBits, Partials, Events, MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { loadConfig, modeOf } from './config.js';
import {
  createQueue, getMatch, listMatches, listQueues, getQueue,
  applyMatchEvent, saveState, loadState,
} from './store.js';
import {
  routeButton, routeModal, refreshResults, refreshBoard, refreshDashboard, refreshPanel,
} from './queue.js';
import { startIngest } from './ingest.js';
import { resultsEmbed, setBrandIcon } from './render.js';
import { startHealth } from './health.js';

const cfg = loadConfig();

if (!cfg._ready) {
  console.error('Refusing to start. Missing:');
  for (const m of cfg._missing) console.error('  - ' + m);
  console.error(`\nConfig source: ${cfg._source}`);
  console.error('Copy config.example.json to config.json and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] ready as ${c.user.tag} (${c.user.id})`);
  console.log(`[bot] guild ${cfg.guildId} | ${cfg._source}`);
  setBrandIcon(c.user.displayAvatarURL({ size: 256, extension: 'png' }));

  // The panel is the one message staff keep open, so it is re-rendered on every boot
  // whether or not anything is running.
  try {
    await refreshPanel(c, cfg);
  } catch (err) {
    console.error('[bot] could not post the control panel:', err.message);
  }

  // Re-render every queue that was open when the process stopped, so a restart
  // never leaves a board showing stale state.
  const open = listQueues('open').concat(listQueues('full'));
  for (const q of open) {
    try {
      await refreshBoard(c, q, cfg);
      if (q.teams?.black?.length) await refreshDashboard(c, q, cfg);
      console.log(`[bot] restored queue ${q.id} (${q.players.length}/${q.maxPlayers})`);
    } catch (err) {
      console.error(`[bot] could not restore queue ${q.id}:`, err.message);
    }
  }

  const live = listMatches('live');
  for (const m of live) {
    try {
      await refreshResults(c, m, cfg);
    } catch (err) {
      console.error(`[bot] could not restore match ${m.id}:`, err.message);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const handled = routeButton(interaction, cfg);
      if (!handled) {
        return interaction.reply({ content: 'Unknown button.', flags: MessageFlags.Ephemeral });
      }
      return await handled;
    }

    if (interaction.isModalSubmit()) {
      const handled = routeModal(interaction, cfg);
      if (!handled) return;
      return await handled;
    }

    if (interaction.isChatInputCommand()) {
      return await handleCommand(interaction);
    }
  } catch (err) {
    console.error('[interaction]', err);
    const payload = { content: 'Internal error: ' + err.message, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

// ---------------------------------------------------------------- commands

// config.roles.staff left empty means every member may run staff commands - the right
// default for a community server that has not made the role yet. Set it to a role id
// and only that role (or anyone with Manage Server) gets through.
function staffGate(interaction) {
  const staffRole = cfg.roles?.staff;
  const perms = interaction.memberPermissions;
  if (perms?.has(PermissionFlagsBits.ManageGuild) || perms?.has(PermissionFlagsBits.Administrator)) return null;
  if (!staffRole) return null;
  const roles = interaction.member?.roles;
  const has = roles?.cache?.has?.(staffRole) ?? (Array.isArray(roles) ? roles.includes(staffRole) : false);
  return has ? null : 'Only scrim staff can run this command.';
}

async function handleCommand(interaction) {
  const { commandName } = interaction;

  const denied = staffGate(interaction);
  if (denied) {
    return interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });
  }

  if (commandName === 'host') {
    const mode = interaction.options.getString('mode') ?? cfg.defaultMode;
    const m = modeOf(cfg, mode);
    if (!m) {
      return interaction.reply({ content: `Unknown mode "${mode}".`, flags: MessageFlags.Ephemeral });
    }
    const queue = createQueue({
      mode,
      maxPlayers: m.maxPlayers,
      teamSize: m.teamSize,
      hostId: interaction.user.id,
      channelId: cfg.channels.queue,
    });
    await refreshBoard(interaction.client, queue, cfg);
    return interaction.reply({
      content: `Lobby **${queue.id}** posted in <#${cfg.channels.queue}>. Cap ${m.maxPlayers}, ${m.teamSize}v${m.teamSize}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (commandName === 'result') {
    return handleResult(interaction);
  }

  if (commandName === 'match') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const live = listMatches('live');
      if (!live.length) return interaction.reply({ content: 'No live matches.', flags: MessageFlags.Ephemeral });
      const lines = live.map((m) => `\`${m.id}\` · ${m.mode} · ${m.score.black}-${m.score.white} · ${m.teams.black.length}v${m.teams.white.length}`);
      return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }
    if (sub === 'show') {
      const id = interaction.options.getString('id');
      const m = getMatch(id);
      if (!m) return interaction.reply({ content: 'No such match.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [resultsEmbed(m, modeOf(cfg, m.mode)?.label ?? m.mode)] });
    }
  }

  if (commandName === 'queue') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const open = listQueues('open').concat(listQueues('full'));
      if (!open.length) return interaction.reply({ content: 'No open queues.', flags: MessageFlags.Ephemeral });
      return interaction.reply({
        content: open.map((q) => `\`${q.id}\` · ${q.mode} · ${q.players.length}/${q.maxPlayers} · ${q.status}`).join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    }
    if (sub === 'cancel') {
      const id = interaction.options.getString('id');
      const q = getQueue(id);
      if (!q) return interaction.reply({ content: 'No such queue.', flags: MessageFlags.Ephemeral });
      const { setQueueStatus } = await import('./store.js');
      setQueueStatus(id, 'cancelled');
      await refreshBoard(interaction.client, getQueue(id), cfg);
      return interaction.reply({ content: 'Cancelled.', flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleResult(interaction) {
  const sub = interaction.options.getSubcommand();
  const matchId = interaction.options.getString('match');
  const match = getMatch(matchId);
  if (!match) {
    return interaction.reply({ content: `No match \`${matchId}\`.`, flags: MessageFlags.Ephemeral });
  }

  let event = null;
  if (sub === 'add') {
    event = {
      type: 'kill',
      killer: interaction.options.getString('killer'),
      victim: interaction.options.getString('victim'),
    };
  } else if (sub === 'score') {
    event = {
      type: 'score',
      side: interaction.options.getString('side'),
      value: interaction.options.getInteger('value'),
    };
  } else if (sub === 'left') {
    event = { type: 'left', player: interaction.options.getString('player') };
  } else if (sub === 'end') {
    event = { type: 'end', side: interaction.options.getString('side') };
  }

  if (!event) {
    return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
  }

  const res = applyMatchEvent(matchId, event);
  if (!res.ok) {
    return interaction.reply({ content: 'Rejected: ' + res.reason, flags: MessageFlags.Ephemeral });
  }

  const fresh = getMatch(matchId);
  fresh.source = fresh.source ?? 'manual';
  saveState();
  await refreshResults(interaction.client, fresh, cfg);

  const summary = event.type === 'kill'
    ? `kill \`${event.killer}\` → \`${event.victim}\``
    : event.type === 'score'
      ? `score ${event.side} = ${event.value}`
      : event.type === 'left'
        ? `left: ${event.player}`
        : `end: ${event.side} wins`;

  return interaction.reply({ content: `Recorded ${summary}.`, flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------- start

const onEvent = async (match) => refreshResults(client, match, cfg);

const healthPort = Number(process.env.PORT ?? 8080);
const ingestPort = Number(process.env.INGEST_PORT ?? cfg.ingest.port);

// Every free host routes exactly one port. The public server mounts /ingest and
// /match itself, so the standalone listener only starts when it has a port of its own.
const events = ingestPort === healthPort ? null : startIngest({ cfg, client, onEvent, port: ingestPort });
const health = startHealth({ client, cfg, onEvent, port: healthPort });

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('[bot] login failed:', err.message);
  process.exit(1);
});

// Ordered shutdown: stop accepting events, then close the gateway.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n[bot] ${sig} - shutting down`);
    try { events?.close(); } catch { /* already closed */ }
    try { health?.close(); } catch { /* already closed */ }
    try { await client.destroy(); } catch { /* already gone */ }
    process.exit(0);
  });
}
