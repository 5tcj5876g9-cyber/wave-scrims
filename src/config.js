// Config loader. Reads config.json next to package.json, falls back to the example
// so a fresh clone gives a clear error instead of a stack trace about undefined.

import './env.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadConfig() {
  const real = join(ROOT, 'config.json');
  const example = join(ROOT, 'config.example.json');
  const file = existsSync(real) ? real : example;
  const cfg = JSON.parse(readFileSync(file, 'utf8'));

  // A container has no config.json, so every id it needs can come from the
  // environment. Env wins over the file, which keeps one image usable on a host and
  // still lets a local run keep its json.
  const env = process.env;
  if (env.DISCORD_GUILD_ID) cfg.guildId = env.DISCORD_GUILD_ID;
  cfg.channels = cfg.channels ?? {};
  if (env.CHANNEL_QUEUE) cfg.channels.queue = env.CHANNEL_QUEUE;
  if (env.CHANNEL_DASHBOARD) cfg.channels.dashboard = env.CHANNEL_DASHBOARD;
  if (env.CHANNEL_RESULTS) cfg.channels.results = env.CHANNEL_RESULTS;
  if (env.CHANNEL_LOG) cfg.channels.resultsLog = env.CHANNEL_LOG;
  cfg.ingest = cfg.ingest ?? {};
  if (env.INGEST_SECRET) cfg.ingest.secret = env.INGEST_SECRET;
  if (env.INGEST_PORT) cfg.ingest.port = Number(env.INGEST_PORT);
  if (env.STAFF_ROLE_ID) {
    cfg.roles = cfg.roles ?? {};
    cfg.roles.staff = env.STAFF_ROLE_ID;
  }

  const missing = [];
  if (!process.env.DISCORD_TOKEN) missing.push('DISCORD_TOKEN environment variable');
  if (!cfg.guildId || cfg.guildId.startsWith('0000')) missing.push('guildId (config.json or DISCORD_GUILD_ID)');
  for (const [k, v] of Object.entries(cfg.channels ?? {})) {
    if (!v || String(v).startsWith('0000')) missing.push(`channels.${k} (config.json or env)`);
  }

  cfg._source = file;
  cfg._missing = missing;
  cfg._ready = missing.length === 0;
  cfg.links = cfg.links ?? { server: null };
  return cfg;
}

export function modeOf(cfg, name) {
  return cfg.modes[name] ?? cfg.modes[cfg.defaultMode];
}

// The panel writes one value at runtime (the private server link), so config.json has
// to be writable. The private fields the loader adds are stripped before saving.
export function saveConfig(cfg) {
  const file = join(ROOT, 'config.json');
  const clean = { ...cfg };
  delete clean._source;
  delete clean._missing;
  delete clean._ready;
  writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return file;
}
