// Slash command definitions in one place, so registration and the setup script can
// never drift apart.
//
// No setDefaultMemberPermissions here on purpose: a scrim server is run by staff with
// a custom role, not necessarily by people holding Discord's built-in ManageEvents.
// The gate lives in index.js and reads config.roles.staff, which can be left empty to
// let every member host.

import { SlashCommandBuilder } from 'discord.js';

export function buildCommands(cfg) {
  const modes = Object.keys(cfg.modes ?? { flat: {} });

  const host = new SlashCommandBuilder()
    .setName('host')
    .setDescription('Post a new scrim lobby with a Join button');
  if (modes.length) {
    host.addStringOption((o) =>
      o.setName('mode').setDescription('Scrim mode').setRequired(false)
        .addChoices(...modes.map((m) => ({ name: m, value: m }))));
  }

  return [
    host.toJSON(),

    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Inspect or cancel open lobbies')
      .addSubcommand((s) => s.setName('list').setDescription('List open lobbies'))
      .addSubcommand((s) =>
        s.setName('cancel').setDescription('Cancel a lobby')
          .addStringOption((o) => o.setName('id').setDescription('Queue id').setRequired(true)))
      .toJSON(),

    new SlashCommandBuilder()
      .setName('result')
      .setDescription('Record match events by hand (the fallback when no bridge is live)')
      .addSubcommand((s) =>
        s.setName('add').setDescription('Record a kill')
          .addStringOption((o) => o.setName('match').setDescription('Match id').setRequired(true))
          .addStringOption((o) => o.setName('killer').setDescription('Roblox username of the killer').setRequired(true))
          .addStringOption((o) => o.setName('victim').setDescription('Roblox username of the victim').setRequired(true)))
      .addSubcommand((s) =>
        s.setName('score').setDescription('Set a side score')
          .addStringOption((o) => o.setName('match').setDescription('Match id').setRequired(true))
          .addStringOption((o) => o.setName('side').setDescription('Which side').setRequired(true)
            .addChoices({ name: 'black', value: 'black' }, { name: 'white', value: 'white' }))
          .addIntegerOption((o) => o.setName('value').setDescription('Round wins').setRequired(true).setMinValue(0).setMaxValue(99)))
      .addSubcommand((s) =>
        s.setName('left').setDescription('Mark a player as having left mid-match')
          .addStringOption((o) => o.setName('match').setDescription('Match id').setRequired(true))
          .addStringOption((o) => o.setName('player').setDescription('Roblox username').setRequired(true)))
      .addSubcommand((s) =>
        s.setName('end').setDescription('End the match and declare a winner')
          .addStringOption((o) => o.setName('match').setDescription('Match id').setRequired(true))
          .addStringOption((o) => o.setName('side').setDescription('Winning side').setRequired(true)
            .addChoices({ name: 'black', value: 'black' }, { name: 'white', value: 'white' })))
      .toJSON(),

    new SlashCommandBuilder()
      .setName('match')
      .setDescription('Inspect live matches')
      .addSubcommand((s) => s.setName('list').setDescription('List live matches'))
      .addSubcommand((s) =>
        s.setName('show').setDescription('Render a match board')
          .addStringOption((o) => o.setName('id').setDescription('Match id').setRequired(true)))
      .toJSON(),
  ];
}
