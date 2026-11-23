# Deploying the bot off your machine

The bot is a Discord **gateway** client: it holds one outbound WebSocket and does not
need a domain, a callback URL, or an inbound port for Discord itself. It does open one
inbound port for the map bridge (`/ingest`, `/match`), which is the only reason the
container exposes anything.

Everything below is free-tier only, no card.

---

## Why not just any free host

| Requirement | Why |
|---|---|
| always on | the gateway drops when the process is killed, and buttons stop answering |
| one public HTTP port | the OCR bridge on the host PC POSTs to `/ingest/<matchId>` |
| env vars | the token must never be inside the image |

A "sleep after 15 minutes of no traffic" web service is the usual trap: the bot is
online, then silently dies. Fix it with any free uptime pinger hitting `/health` every
5–10 minutes, or pick a host whose free tier does not sleep.

---

## Render (recommended free path)

1. Push this folder to a GitHub repository (private is fine).
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml`.
3. Fill the secrets Render asks for:

| Variable | Where it comes from |
|---|---|
| `DISCORD_TOKEN` | the bot token |
| `DISCORD_GUILD_ID` | `guildId` in `config.json` |
| `CHANNEL_QUEUE` | `channels.queue` |
| `CHANNEL_DASHBOARD` | `channels.dashboard` |
| `CHANNEL_RESULTS` | `channels.results` |
| `CHANNEL_LOG` | `channels.resultsLog` |
| `INGEST_SECRET` | `ingest.secret` |
| `STAFF_ROLE_ID` | `roles.staff` (after `node scripts/channels.js --private`) |

4. Deploy. `https://<service>.onrender.com/health` must answer
   `{"ok":true,"bot":{"ready":true,...}}`.
5. Add a free monitor (cron-job.org or UptimeRobot) on that URL every 10 minutes. That
   is what keeps a free web service from idling out.
6. Point the bridge at the public URL instead of localhost:

```
python bridge/ocr-bridge.py --match m_xxxx \
    --url https://<service>.onrender.com --secret "$INGEST_SECRET" --window Roblox
```

`/ingest` is served on the same port as `/health` when `INGEST_PORT` is unset, so a host
that only routes one port still works. Set `INGEST_PORT` only if the platform gives you
a second port.

---

## Alternatives that behave

| Host | Free? | Notes |
|---|---|---|
| Fly.io | trial credit | `fly launch --dockerfile Dockerfile`, needs a card on file |
| Koyeb | free instance | Docker deploy, may scale to zero on the free plan |
| Railway | trial credit | easiest UI, credit runs out |
| Oracle Cloud Free Tier | always free VM | needs a card for identity, then it is a real VM you keep |

The image is standard, so any of these takes it without changes. Only the environment
variables differ.

---

## State and restarts

State is `data/state.json`, and `SCRIMS_DATA_DIR` points it anywhere:

```
SCRIMS_DATA_DIR=/data node src/index.js
```

On a host with an ephemeral disk an open lobby or a live match is lost on redeploy.
That is acceptable for scrims (a redeploy happens between sessions), but if it is not,
mount a volume at `/app/data` — the Dockerfile already declares it. The private server
link set from the panel lives in that file too, so a volume keeps it.
