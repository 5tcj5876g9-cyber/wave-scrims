// The queue, the control panel and everything a button on either of them does.
//
// Buttons carry what they need in their customId:
//   q:<action>:<queueId>  the lobby card, one id per button so it survives a restart
//   p:<action>            the dashboard panel, which always acts on the lobby or match
//                         that is currently running
// Every handler re-reads state from disk first, so two people clicking at once cannot
// both take the eighth slot: the second write sees the full queue and is refused.

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, MessageFlags,
} from 'discord.js';
import {
  getQueue, addPlayer, removePlayer, setTeams, setQueueStatus, createQueue,
  createMatch, setMessageRef, getMessageRef, saveState, loadState, listQueues,
  currentQueue, latestMatch, applyMatchEvent, getMatch, getSettings, setSetting,
} from './store.js';
import {
  queueEmbed, queueButtons, dashboardEmbed, panelEmbed, panelButtons,
} from './render.js';
import { splitRandom, splitBalanced, validate } from './teams.js';
import { modeOf } from './config.js';

// ---------------------------------------------------------------- member buttons

// A Discord member needs a Roblox handle before the dashboard is useful. Asking once
// via a modal is cheaper than a separate registration command.
export async function handleJoin(interaction, cfg) {
  const queueId = interaction.customId.split(':')[2];
  const q = getQueue(queueId);
  if (!q) {
    return interaction.reply({ content: 'That queue no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (q.players.some((p) => p.discordId === interaction.user.id)) {
    return interaction.reply({ content: 'You are already in this lobby.', flags: MessageFlags.Ephemeral });
  }
  if (q.players.length >= q.maxPlayers) {
    return interaction.reply({ content: `Lobby is full (${q.maxPlayers}).`, flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(`q:roblox:${queueId}`)
    .setTitle('Join scrim')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('roblox')
          .setLabel('Your Roblox username')
          .setPlaceholder('exactly as it appears in game')
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(20)
          .setRequired(true),
      ),
    );
  return interaction.showModal(modal);
}

export async function handleJoinModal(interaction, cfg) {
  const queueId = interaction.customId.split(':')[2];
  const roblox = interaction.fields.getTextInputValue('roblox').trim();
  const q = getQueue(queueId);
  if (!q) {
    return interaction.reply({ content: 'That queue no longer exists.', flags: MessageFlags.Ephemeral });
  }

  const result = addPlayer(queueId, {
    discordId: interaction.user.id,
    tag: interaction.user.username,
    roblox,
    role: 'player',
  });

  if (!result.ok) {
    const msg = {
      'already joined': 'You are already in this lobby.',
      'queue is full': `Lobby is full (${q.maxPlayers}).`,
    }[result.reason] ?? `Could not join: ${result.reason}`;
    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }

  await refreshBoard(interaction.client, result.queue, cfg);
  await refreshPanel(interaction.client, cfg);
  const left = result.queue.maxPlayers - result.queue.players.length;

  return interaction.reply({
    content: left === 0
      ? `**${roblox}** took the last slot. Lobby is full.`
      : `**${roblox}** joined. ${left} slot${left === 1 ? '' : 's'} left.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleLeave(interaction, cfg) {
  const queueId = interaction.customId.split(':')[2];
  const result = removePlayer(queueId, interaction.user.id);
  if (!result.ok) {
    return interaction.reply({ content: 'You are not in this lobby.', flags: MessageFlags.Ephemeral });
  }
  await refreshBoard(interaction.client, result.queue, cfg);
  await refreshPanel(interaction.client, cfg);
  return interaction.reply({ content: 'You left the lobby.', flags: MessageFlags.Ephemeral });
}

export async function handleRefresh(interaction, cfg) {
  const queueId = interaction.customId.split(':')[2];
  const q = getQueue(queueId);
  if (!q) return interaction.reply({ content: 'Gone.', flags: MessageFlags.Ephemeral });
  await refreshBoard(interaction.client, q, cfg);
  return interaction.reply({ content: 'Refreshed.', flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------- shared actions

export async function doSplit(client, queue, cfg) {
  if (queue.players.length !== queue.maxPlayers) {
    return { ok: false, reason: `need exactly ${queue.maxPlayers} players, have ${queue.players.length}` };
  }
  const ratings = loadState().ratings ?? {};
  const teams = cfg.split === 'balanced'
    ? splitBalanced(queue.players, queue.teamSize, ratings)
    : splitRandom(queue.players, queue.teamSize);

  const problems = validate(teams, queue.teamSize);
  if (problems.length) return { ok: false, reason: problems.join('; ') };

  teams.black[0].role = 'captain';
  teams.white[0].role = 'captain';

  const updated = setTeams(queue.id, teams);
  await refreshBoard(client, updated, cfg);
  await refreshDashboard(client, updated, cfg);
  await refreshPanel(client, cfg);
  return { ok: true, queue: updated };
}

export async function doStart(client, queue, cfg) {
  if (queue.players.length < queue.maxPlayers) {
    return { ok: false, reason: `${queue.players.length}/${queue.maxPlayers} players` };
  }
  if (!queue.teams?.black?.length) return { ok: false, reason: 'split the teams first' };

  const match = createMatch({
    queueId: queue.id,
    mode: queue.mode,
    teams: queue.teams,
    channelId: cfg.channels.results,
  });
  setQueueStatus(queue.id, 'started');

  const fresh = getQueue(queue.id);
  await refreshBoard(client, fresh, cfg);
  await refreshDashboard(client, fresh, cfg);
  await postResults(client, match, cfg);
  await refreshPanel(client, cfg);
  return { ok: true, match };
}

export async function doEnd(client, match, cfg) {
  const side = match.score.black === match.score.white
    ? null
    : match.score.black > match.score.white ? 'black' : 'white';
  if (!side) return { ok: false, reason: 'scores are level, set the score first' };

  applyMatchEvent(match.id, { type: 'end', side });
  const fresh = getMatch(match.id);
  fresh.source = fresh.source ?? 'manual';
  saveState();
  await refreshResults(client, fresh, cfg);
  await refreshPanel(client, cfg);
  return { ok: true, match: fresh };
}

export async function handleSplit(interaction, cfg) {
  const queueId = interaction.customId.split(':')[2];
  const q = getQueue(queueId);
  if (!q) return interaction.reply({ content: 'Gone.', flags: MessageFlags.Ephemeral });
  const result = await doSplit(interaction.client, q, cfg);
  if (!result.ok) return interaction.reply({ content: 'Split failed: ' + result.reason, flags: MessageFlags.Ephemeral });
  return interaction.reply({ content: 'Teams set. Check the dashboard room.', flags: MessageFlags.Ephemeral });
}

export async function handleStart(interaction, cfg) {
  const queueId = interaction.customId.split(':')[2];
  const q = getQueue(queueId);
  if (!q) return interaction.reply({ content: 'Gone.', flags: MessageFlags.Ephemeral });
  const result = await doStart(interaction.client, q, cfg);
  if (!result.ok) return interaction.reply({ content: 'Cannot start: ' + result.reason, flags: MessageFlags.Ephemeral });
  return interaction.reply({
    content: `Match **${result.match.id}** started. Results board is live in <#${cfg.channels.results}>.\n` +
      `Ingest: \`POST /ingest/${result.match.id}\` · manual fallback \`/result\``,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleCancel(interaction, cfg) {
  const queueId = interaction.customId.split(':')[2];
  const q = getQueue(queueId);
  if (!q) return interaction.reply({ content: 'Gone.', flags: MessageFlags.Ephemeral });
  setQueueStatus(queueId, 'cancelled');
  const refreshed = getQueue(queueId);
  await refreshBoard(interaction.client, refreshed, cfg);
  await refreshPanel(interaction.client, cfg);
  return interaction.reply({ content: 'Queue cancelled.', flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------- panel buttons

export async function panelHost(interaction, cfg) {
  // "Restart lobby" must not leave the previous one joinable in the queue room.
  for (const q of listQueues('open').concat(listQueues('full'))) {
    setQueueStatus(q.id, 'cancelled');
    await refreshBoard(interaction.client, getQueue(q.id), cfg).catch(() => {});
  }

  const m = modeOf(cfg, cfg.defaultMode);
  const queue = createQueue({
    mode: cfg.defaultMode,
    maxPlayers: m.maxPlayers,
    teamSize: m.teamSize,
    hostId: interaction.user.id,
    channelId: cfg.channels.queue,
  });
  await refreshBoard(interaction.client, queue, cfg);
  await refreshPanel(interaction.client, cfg);
  return interaction.reply({
    content: `Lobby \`${queue.id}\` posted in <#${cfg.channels.queue}>. Cap ${m.maxPlayers}, ${m.teamSize}v${m.teamSize}.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function panelCancel(interaction, cfg) {
  const queue = currentQueue();
  if (!queue) return interaction.reply({ content: 'No lobby open.', flags: MessageFlags.Ephemeral });
  setQueueStatus(queue.id, 'cancelled');
  await refreshBoard(interaction.client, getQueue(queue.id), cfg);
  await refreshPanel(interaction.client, cfg);
  return interaction.reply({ content: `Lobby \`${queue.id}\` cancelled.`, flags: MessageFlags.Ephemeral });
}

export async function panelSplit(interaction, cfg) {
  const queue = currentQueue();
  if (!queue) return interaction.reply({ content: 'No lobby open.', flags: MessageFlags.Ephemeral });
  const result = await doSplit(interaction.client, queue, cfg);
  if (!result.ok) return interaction.reply({ content: 'Split failed: ' + result.reason, flags: MessageFlags.Ephemeral });
  return interaction.reply({ content: 'Teams set. See the split board below the panel.', flags: MessageFlags.Ephemeral });
}

export async function panelStart(interaction, cfg) {
  const queue = currentQueue();
  if (!queue) return interaction.reply({ content: 'No lobby open.', flags: MessageFlags.Ephemeral });
  const result = await doStart(interaction.client, queue, cfg);
  if (!result.ok) return interaction.reply({ content: 'Cannot start: ' + result.reason, flags: MessageFlags.Ephemeral });
  return interaction.reply({
    content: `Match \`${result.match.id}\` started. Results in <#${cfg.channels.results}>.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function panelEnd(interaction, cfg) {
  const match = latestMatch();
  if (!match) return interaction.reply({ content: 'No live match.', flags: MessageFlags.Ephemeral });
  const result = await doEnd(interaction.client, match, cfg);
  if (!result.ok) return interaction.reply({ content: 'Cannot end: ' + result.reason, flags: MessageFlags.Ephemeral });
  return interaction.reply({ content: `Match \`${match.id}\` ended.`, flags: MessageFlags.Ephemeral });
}

export async function panelRefresh(interaction, cfg) {
  await refreshPanel(interaction.client, cfg);
  return interaction.reply({ content: 'Panel refreshed.', flags: MessageFlags.Ephemeral });
}

export async function panelBoards(interaction, cfg) {
  const queue = currentQueue();
  if (queue) {
    await refreshBoard(interaction.client, queue, cfg);
    await refreshDashboard(interaction.client, queue, cfg);
  }
  const match = latestMatch();
  if (match) await refreshResults(interaction.client, match, cfg);
  await refreshPanel(interaction.client, cfg);
  return interaction.reply({ content: 'Every board reposted.', flags: MessageFlags.Ephemeral });
}

// The private-server invite is the one thing the bot cannot invent, so staff sets it
// from the panel and the Join button turns into a real link.
export async function panelLinkModal(interaction, cfg) {
  const modal = new ModalBuilder()
    .setCustomId('p:link:save')
    .setTitle('Private server link')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('url')
          .setLabel('Roblox private server URL')
          .setPlaceholder('https://www.roblox.com/games/11379739543/...?privateServerLinkCode=...')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200),
      ),
    );
  return interaction.showModal(modal);
}

export async function panelLinkSave(interaction, cfg) {
  const raw = interaction.fields.getTextInputValue('url').trim();
  if (raw && !/^https:\/\/[\w.-]+\/\S*$/i.test(raw)) {
    return interaction.reply({ content: 'That is not an https url.', flags: MessageFlags.Ephemeral });
  }
  setSetting('server', raw || null);
  await refreshPanel(interaction.client, cfg);
  return interaction.reply({
    content: raw ? 'Server link saved. The Join button is live.' : 'Server link cleared.',
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------- board refresh

export async function refreshBoard(client, queue, cfg) {
  const modeLabel = modeOf(cfg, queue.mode)?.label ?? queue.mode;
  const key = 'queue:' + queue.id;
  const ref = getMessageRef(key);

  const payload = {
    embeds: [queueEmbed(queue, modeLabel)],
    components: queueButtons(queue),
  };

  if (ref) {
    try {
      const ch = await client.channels.fetch(ref.channelId);
      const msg = await ch.messages.fetch(ref.messageId);
      await msg.edit(payload);
      return msg;
    } catch {
      // message was deleted by a moderator; fall through and post a new one
    }
  }

  const ch = await client.channels.fetch(queue.channelId);
  const msg = await ch.send(payload);
  setMessageRef(key, ch.id, msg.id);
  return msg;
}

export async function refreshDashboard(client, queue, cfg) {
  const modeLabel = modeOf(cfg, queue.mode)?.label ?? queue.mode;
  const key = 'dashboard:' + queue.id;
  const ref = getMessageRef(key);

  const payload = { embeds: [dashboardEmbed(queue, modeLabel)] };

  if (ref) {
    try {
      const ch = await client.channels.fetch(ref.channelId);
      const msg = await ch.messages.fetch(ref.messageId);
      await msg.edit(payload);
      return msg;
    } catch { /* repost below */ }
  }

  const ch = await client.channels.fetch(cfg.channels.dashboard);
  const msg = await ch.send(payload);
  setMessageRef(key, ch.id, msg.id);
  return msg;
}

// One panel per guild, edited in place. It is the message staff keep open.
export async function refreshPanel(client, cfg) {
  const queue = currentQueue();
  const match = latestMatch();
  const server = getSettings().server ?? cfg.links?.server ?? null;
  const payload = {
    embeds: [panelEmbed({ queue, match, cfg, server })],
    components: panelButtons({ queue, match, cfg, server }),
  };

  const ref = getMessageRef('panel');
  if (ref) {
    try {
      const ch = await client.channels.fetch(ref.channelId);
      const msg = await ch.messages.fetch(ref.messageId);
      await msg.edit(payload);
      return msg;
    } catch { /* message gone, adopt or repost below */ }
  }

  const ch = await client.channels.fetch(cfg.channels.dashboard);

  // A hosted process has no state.json on first boot, so it cannot know the id of the
  // panel it posted last time. Look for it instead of stacking a copy, and clear the
  // duplicates a few redeploys have left behind.
  try {
    const recent = await ch.messages.fetch({ limit: 25 });
    const mine = [...recent.values()]
      .filter((m) => m.author.id === client.user.id && m.embeds?.[0]?.title === 'CONTROL')
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    if (mine.length) {
      for (const duplicate of mine.slice(1)) {
        await duplicate.delete().catch(() => {});
      }
      await mine[0].edit(payload);
      setMessageRef('panel', ch.id, mine[0].id);
      return mine[0];
    }
  } catch (err) {
    console.error('[panel] could not scan for an existing panel:', err.message);
  }

  const msg = await ch.send(payload);
  setMessageRef('panel', ch.id, msg.id);
  return msg;
}

// Runs once per boot: a few redeploys in a row would otherwise leave a stack of
// control panels in the room, each with working buttons pointing at stale state.
export async function prunePanels(client, cfg) {
  const ref = getMessageRef('panel');
  if (!ref) return 0;
  const ch = await client.channels.fetch(cfg.channels.dashboard);
  const recent = await ch.messages.fetch({ limit: 25 });
  const duplicates = [...recent.values()].filter(
    (m) => m.author.id === client.user.id
      && m.embeds?.[0]?.title === 'CONTROL'
      && m.id !== ref.messageId,
  );
  for (const duplicate of duplicates) {
    await duplicate.delete().catch(() => {});
  }
  return duplicates.length;
}

export async function postResults(client, match, cfg) {
  const { resultsEmbed } = await import('./render.js');
  const modeLabel = modeOf(cfg, match.mode)?.label ?? match.mode;
  const ch = await client.channels.fetch(cfg.channels.results);
  const msg = await ch.send({ embeds: [resultsEmbed(match, modeLabel)] });
  setMessageRef('match:' + match.id, ch.id, msg.id);
  return msg;
}

export async function refreshResults(client, match, cfg) {
  const { resultsEmbed } = await import('./render.js');
  const modeLabel = modeOf(cfg, match.mode)?.label ?? match.mode;
  const ref = getMessageRef('match:' + match.id);
  if (!ref) return postResults(client, match, cfg);
  try {
    const ch = await client.channels.fetch(ref.channelId);
    const msg = await ch.messages.fetch(ref.messageId);
    await msg.edit({ embeds: [resultsEmbed(match, modeLabel)] });
    return msg;
  } catch {
    return postResults(client, match, cfg);
  }
}

// ---------------------------------------------------------------- routers

export function routeButton(interaction, cfg) {
  const [scope, action] = interaction.customId.split(':');

  if (scope === 'p') {
    switch (action) {
      case 'host':    return panelHost(interaction, cfg);
      case 'cancel':  return panelCancel(interaction, cfg);
      case 'split':   return panelSplit(interaction, cfg);
      case 'start':   return panelStart(interaction, cfg);
      case 'end':     return panelEnd(interaction, cfg);
      case 'refresh': return panelRefresh(interaction, cfg);
      case 'boards':  return panelBoards(interaction, cfg);
      case 'link':    return panelLinkModal(interaction, cfg);
      default:        return null;
    }
  }

  switch (action) {
    case 'join':   return handleJoin(interaction, cfg);
    case 'leave':  return handleLeave(interaction, cfg);
    case 'list':   return handleRefresh(interaction, cfg);
    case 'split':  return handleSplit(interaction, cfg);
    case 'start':  return handleStart(interaction, cfg);
    case 'cancel': return handleCancel(interaction, cfg);
    default:       return null;
  }
}

export function routeModal(interaction, cfg) {
  if (interaction.customId.startsWith('q:roblox:')) return handleJoinModal(interaction, cfg);
  if (interaction.customId === 'p:link:save') return panelLinkSave(interaction, cfg);
  return null;
}
