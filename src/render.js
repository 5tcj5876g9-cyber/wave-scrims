// Every pixel the bot sends is built here: the queue board, the dashboard and the
// results board. One brand, one palette, one place to change it.
//
// The mark is the bot's own avatar, published by Discord as a stable CDN url, so no
// message ever carries an upload and a refresh costs nothing.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

export const BRAND = {
  name: 'WAVE',
  tagline: 'ROBLOX SCRIMS',
  accent: 0xC9D6E8,
  iconURL: null,   // set once the client is ready, see setBrandIcon()
};

export function setBrandIcon(url) {
  BRAND.iconURL = url || null;
}

export const COLOURS = {
  open: 0x141A24,    // deep navy - the panel behind the wordmark
  full: 0x8FA3BF,    // brushed steel - lobby is closed
  live: 0xF2B33D,    // amber - the only warm colour in the set, so "live" reads instantly
  done: 0xC9D6E8,    // highlight silver - match finished
  neutral: 0x0B0F16,
};

function brand(embed, { thumbnail = false } = {}) {
  if (BRAND.iconURL) {
    embed.setAuthor({ name: BRAND.name, iconURL: BRAND.iconURL });
    if (thumbnail) embed.setThumbnail(BRAND.iconURL);
  } else {
    embed.setAuthor({ name: BRAND.name });
  }
  return embed;
}

const ROLE_LABEL = {
  host: 'Host',
  captain: 'Captain',
  player: 'Player',
};

// ---------------------------------------------------------------- queue board

export function queueEmbed(queue, modeLabel) {
  const n = queue.players.length;
  const cap = queue.maxPlayers;
  const teams = queue.teams ?? { black: [], white: [] };
  const split = teams.black.length > 0;

  const e = new EmbedBuilder()
    .setColor(queue.status === 'full' ? COLOURS.full : COLOURS.open)
    .setTitle('SCRIMS')
    .setDescription(
      queue.status === 'open'
        ? `**${modeLabel}** — ${n}/${cap} players. Press **Join** to take a slot.`
        : queue.status === 'full'
          ? `**${modeLabel}** — lobby full. Staff can start the match.`
          : `**${modeLabel}** — ${queue.status}.`
    );

  if (!split) {
    e.addFields({
      name: `Players (${n}/${cap})`,
      value: n ? queue.players.map((p, i) => `\`${String(i + 1).padStart(2, '0')}\` ${mention(p)}`).join('\n') : '*nobody yet*',
      inline: false,
    });
  } else {
    e.addFields(
      { name: `BLACK (${teams.black.length})`, value: teamList(teams.black), inline: true },
      { name: `WHITE (${teams.white.length})`, value: teamList(teams.white), inline: true },
    );
  }

  brand(e);
  e.setFooter({ text: `${BRAND.name} · ${modeLabel.toUpperCase()}` });
  return e;
}

function teamList(players) {
  if (!players.length) return '*empty*';
  return players.map((p) => mention(p)).join('\n');
}

function mention(p) {
  const roblox = p.roblox ? ` \`${p.roblox}\`` : '';
  return `<@${p.discordId}>${roblox}`;
}

export function queueButtons(queue) {
  const full = queue.players.length >= queue.maxPlayers || queue.status !== 'open';

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q:join:${queue.id}`)
      .setLabel(full ? 'Lobby full' : 'Join')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Success)
      .setDisabled(full),
    new ButtonBuilder()
      .setCustomId(`q:leave:${queue.id}`)
      .setLabel('Leave')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(queue.status !== 'open' && queue.status !== 'full'),
    new ButtonBuilder()
      .setCustomId(`q:list:${queue.id}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q:split:${queue.id}`)
      .setLabel('Split teams')
      .setEmoji('⚖️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(queue.status === 'started' || queue.status === 'cancelled'),
    new ButtonBuilder()
      .setCustomId(`q:start:${queue.id}`)
      .setLabel('Start match')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(queue.players.length < queue.maxPlayers),
    new ButtonBuilder()
      .setCustomId(`q:cancel:${queue.id}`)
      .setLabel('Cancel')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

// ---------------------------------------------------------------- dashboard

export function dashboardEmbed(queue, modeLabel) {
  const teams = queue.teams ?? { black: [], white: [] };
  const ready = teams.black.length > 0 && teams.white.length > 0;

  const e = new EmbedBuilder()
    .setColor(ready ? COLOURS.live : COLOURS.neutral)
    .setTitle(modeLabel)
    .setDescription(
      ready
        ? 'Teams are set. Copy the usernames below into the private server.'
        : 'Waiting for a full lobby, then staff presses **Split teams**.'
    );

  const block = (players) => {
    if (!players.length) return '*not assigned*';
    return players
      .map((p, i) => {
        const roblox = p.roblox ? `\`${p.roblox}\`` : '`— no roblox name —`';
        return `\`${i + 1}\` ${roblox}\n     ↳ <@${p.discordId}> · ${ROLE_LABEL[p.role] ?? 'Player'}`;
      })
      .join('\n');
  };

  e.addFields(
    { name: 'BLACK', value: block(teams.black), inline: true },
    { name: 'WHITE', value: block(teams.white), inline: true },
  );

  brand(e);
  e.setFooter({ text: `${BRAND.name} · queue ${queue.id} · ${queue.players.length}/${queue.maxPlayers} joined` });
  return e;
}

// ---------------------------------------------------------------- results

// Score centred at the top, one column per side, each player row carrying display
// name, roblox handle, role and K/D.
export function resultsEmbed(match, modeLabel) {
  const stats = match.stats ?? {};
  const s = (p) => stats[p.roblox?.toLowerCase()] ?? { kills: 0, deaths: 0, left: false };

  const winner = match.winner ?? (match.score.black > match.score.white ? 'black' : match.score.white > match.score.black ? 'white' : null);
  const verdict =
    match.status !== 'done'
      ? 'In progress'
      : winner === 'black'
        ? 'Black wins'
        : winner === 'white'
          ? 'White wins'
          : 'Draw';

  const column = (players) => {
    if (!players?.length) return '*no players*';
    return players
      .map((p) => {
        const st = s(p);
        const kd = `${st.kills} / ${st.deaths}`;
        const flag = st.left ? ' ⚠️' : '';
        return `**${p.tag ?? p.roblox ?? 'unknown'}**${p.roblox ? ` (${p.roblox})` : ''}${flag}\n${ROLE_LABEL[p.role] ?? 'Player'} — \`${kd}\``;
      })
      .join('\n\n');
  };

  const e = new EmbedBuilder()
    .setColor(verdict.includes('wins') ? COLOURS.done : COLOURS.live)
    .setTitle('RANKED SCRIM')
    .setDescription(`**${verdict}**`);

  e.addFields(
    { name: 'BLACK', value: `\`${match.score.black}\``, inline: true },
    { name: 'SCORE', value: '**=**', inline: true },
    { name: 'WHITE', value: `\`${match.score.white}\``, inline: true },
  );

  e.addFields(
    { name: '\u200b', value: column(match.teams?.black), inline: true },
    { name: '\u200b', value: column(match.teams?.white), inline: true },
  );

  const leftMid = [];
  for (const side of ['black', 'white']) {
    for (const p of match.teams?.[side] ?? []) {
      const st = stats[p.roblox?.toLowerCase()];
      if (st?.left) leftMid.push(`${p.tag ?? p.roblox} (${p.roblox})`);
    }
  }
  if (leftMid.length) {
    e.addFields({ name: 'Left mid-match', value: leftMid.join(', '), inline: false });
  }

  const src = match.source ? ` · ${match.source}` : '';
  brand(e, { thumbnail: true });
  e.setFooter({ text: `${BRAND.name} · ${modeLabel.toUpperCase()} · ${match.id}${src}` });
  return e;
}

// ---------------------------------------------------------------- control panel

// The dashboard is the room staff actually live in: one message, six buttons, always
// showing the lobby that is running and the match that is live.
export function panelEmbed({ queue, match, cfg, server }) {
  const modeLabel = queue ? (cfg.modes?.[queue.mode]?.label ?? queue.mode) : null;

  const e = new EmbedBuilder()
    .setColor(match ? COLOURS.live : queue ? COLOURS.open : COLOURS.neutral)
    .setTitle('CONTROL')
    .setDescription(
      match
        ? `**${modeLabel}** — match \`${match.id}\` is live. The results board in <#${cfg.channels.results}> updates on every event.`
        : queue
          ? `**${modeLabel}** — lobby \`${queue.id}\` is ${queue.status} (${queue.players.length}/${queue.maxPlayers}).`
          : 'No lobby open. Press **New lobby** to post one in the queue room.'
    );

  e.addFields(
    {
      name: 'LOBBY',
      value: queue
        ? `\`${queue.id}\` · ${queue.players.length}/${queue.maxPlayers} · ${queue.status}${queue.teams?.black?.length ? `\n4v4 split set` : ''}`
        : '*none*',
      inline: true,
    },
    {
      name: 'MATCH',
      value: match
        ? `\`${match.id}\` · ${match.score.black}-${match.score.white} · ${match.status}`
        : '*none live*',
      inline: true,
    },
    {
      name: 'SERVER LINK',
      value: server ? `<${server}>` : '*not set — staff presses Set link*',
      inline: true,
    },
  );

  brand(e);
  e.setFooter({ text: `${BRAND.name} · ${BRAND.tagline}` });
  return e;
}

export function panelButtons({ queue, match, cfg, server }) {
  const teamSize = queue?.teamSize ?? cfg.modes?.[cfg.defaultMode]?.teamSize ?? 4;
  const cap = queue?.maxPlayers ?? cfg.modes?.[cfg.defaultMode]?.maxPlayers ?? 8;

  const join = new ButtonBuilder()
    .setLabel(server ? 'Join server' : 'No server link')
    .setEmoji('🎮')
    .setStyle(server ? ButtonStyle.Link : ButtonStyle.Secondary)
    .setDisabled(!server);
  // A link button rejects custom_id; every other style requires one.
  if (server) join.setURL(server);
  else join.setCustomId('p:nolink');

  const resultsLink = new ButtonBuilder()
    .setLabel('Results room')
    .setEmoji('📊')
    .setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${cfg.guildId}/${cfg.channels.results}`);

  const row1 = new ActionRowBuilder().addComponents(
    join,
    new ButtonBuilder()
      .setCustomId('p:host')
      .setLabel(queue ? 'Restart lobby' : 'New lobby')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('p:cancel')
      .setLabel('Cancel lobby')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!queue),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('p:split')
      .setLabel(`Split ${teamSize}v${teamSize}`)
      .setEmoji('⚖️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!queue || queue.players.length !== cap),
    new ButtonBuilder()
      .setCustomId('p:start')
      .setLabel('Start match')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!queue || queue.players.length !== cap || !queue.teams?.black?.length),
    new ButtonBuilder()
      .setCustomId('p:refresh')
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('p:link')
      .setLabel('Set server link')
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('p:boards')
      .setLabel('Repost boards')
      .setEmoji('📌')
      .setStyle(ButtonStyle.Secondary),
    resultsLink,
    ...(match
      ? [new ButtonBuilder()
        .setCustomId('p:end')
        .setLabel('End match')
        .setEmoji('🏁')
        .setStyle(ButtonStyle.Danger)]
      : []),
  );

  return [row1, row2, row3];
}

// ---------------------------------------------------------------- misc

export function notifyRolesEmbed() {
  const e = new EmbedBuilder()
    .setColor(COLOURS.neutral)
    .setTitle('Notification Roles')
    .setDescription(
      'Stay up to date and receive live alerts for scrims and ranked, using the buttons below to self-assign notification roles.'
    )
    .addFields(
      { name: '🔔 Scrim NA', value: 'Pinged when an NA scrim lobby is starting', inline: false },
      { name: '🔔 Scrim EU', value: 'Pinged when an EU scrim lobby is starting', inline: false },
    );
  brand(e);
  e.setFooter({ text: `${BRAND.name} · ${BRAND.tagline}` });
  return e;
}
