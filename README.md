# wave-scrims

Discord bot for Roblox 4v4 scrims, branded for the **Wave** server. Join button,
8-player cap, 4v4 split, a dashboard channel that lists both teams with Roblox
usernames, and a results board with per-player kills and deaths.

```
npm install
echo DISCORD_TOKEN=your-bot-token > .env
npm run setup      # finds the guild, creates the channels, writes config.json,
                   # sets the bot avatar from assets/wave.png, registers the commands
npm start
```

Node 20+. No database — state is one JSON file in `data/state.json`, written
atomically, so a crash never loses an open queue.

---

## Brand

Every embed carries `WAVE` as its author with the bot's own avatar as the icon, so no
message ever uploads a file and a refresh costs nothing.

| Token | Value | Where |
|---|---|---|
| `BRAND.name` | `WAVE` | embed author, every footer |
| open | `#141A24` | lobby halfway full |
| full | `#8FA3BF` | lobby closed |
| live | `#F2B33D` | teams set / match running |
| done | `#C9D6E8` | match finished |

`assets/wave.png` is the mark: it is uploaded as the bot avatar by `npm run setup` and
as the application icon in the developer portal. `assets/make-logo.py` regenerates it
from scratch if the file is ever lost — it is a remake, not the community's original
file, so dropping the real artwork over it is always the better move.

## Scripts

| Command | Does |
|---|---|
| `npm run setup` | guild lookup, channel creation, config.json, avatar, commands |
| `npm start` | the bot |
| `npm run status` | read-only dump of every channel's last board and the bot presence |
| `npm run demo -- --results` | posts one joinable lobby plus a labelled demo result board |
| `npm run selftest` | 30 checks, no token, isolated state dir |
| `npm run e2e:ocr` | 14 checks, drives the real Python OCR bridge |

---

## What it does

| Surface | Behaviour |
|---|---|
| `/host [mode]` | posts a lobby card with a **Join** button under the embed |
| Join | opens a modal for the Roblox username, then takes a slot |
| Cap | hard 8. The 9th click is refused with "Lobby is full (8)" |
| Split teams | 4v4, random or rating-balanced, no player on both sides |
| Dashboard channel | one message, edited in place, lists both teams and their usernames |
| Start match | creates the match, posts the results board, returns the ingest URL |
| Results board | score at top, two columns, `display name (roblox)`, role, `kills / deaths`, left-mid-match flag |
| `/result add\|score\|left\|end` | manual recording, always available |
| `POST /ingest/<matchId>` | the machine path, for the bridge below |
| `GET /match/<matchId>` | roster + current stats, secret-protected, used by the OCR bridge |

Every button carries its queue id in the `customId`, so it keeps working after a
restart with no collector and no in-memory registry.

---

## The part you actually asked about: connecting to a map that is not yours

The bot cannot read a Roblox server it has no relationship with. There is no API that
returns "who killed whom" for someone else's place — Open Cloud exposes place metadata
and datastores you own, not live match state. So the question is not *how does the bot
read the map*, it is **who feeds the bot**.

Four feeds exist. Each is built into the same `POST /ingest/<matchId>` endpoint, so
you can start on the cheapest today and switch later without touching Discord.

### Route 1 — you control the place (full auto, this is how the reference board works)

The board in your screenshot reports `Left mid-match: pillowfightGOD2941` — that is a
script inside the place watching `PlayerRemoving`. Nobody reads that from outside.

If you cannot edit the map as-is, you fork it: **Roblox Studio → File → Save a Copy**,
then run your own place. Most scrim communities already do this. The map being "not
ours" is usually a permission question, not a technical one — the private server host
is the one who needs to allow it.

Then:

1. Game Settings → Security → **Allow HTTP Requests** = on
2. Drop `bridge/roblox-script.lua` into ServerScriptService
3. Set `INGEST_URL` and `SECRET` at the top of that file from your `config.json`

That script reports:

- kills, with attribution from either `Humanoid:GetAttribute("LastAttackerUserId")`
  (set by your weapon code) or a direct `bridge:RegisterKill(attacker, victim)` call
- round scores, from `ReplicatedStorage.BlackScore/WhiteScore` or `bridge:SetScore()`
- disconnects, immediately, so "left mid-match" is accurate
- events batched every 2 seconds, with a 200-event cap so a stalled host cannot grow
  memory

It knows which team is which because Roblox already knows: `Player.Team.Name`
containing `black` or `white`. That is the whole answer to "how does the bot know this
team from that team".

### Route 2 — you do not control the place (screenshot bridge) — **built, `bridge/ocr-bridge.py`**

The host runs a companion on their own PC. It captures the Roblox window, reads the
leaderboard with the OCR engine that already ships in Windows
(`Windows.Media.Ocr` — no Tesseract, no cloud, no API key), and POSTs per-player
numbers to the same endpoint.

```
pip install winsdk mss pillow

python bridge/ocr-bridge.py --match m_ab12cd34 --url http://127.0.0.1:8099 \
    --secret "<ingest.secret>" --window Roblox
```

It works on a map you cannot touch because it never asks the map anything:

1. It pulls the roster from `GET /match/<matchId>` — the bot already ran the 4v4
   split, so the exact Roblox spelling and the side come from the bot, not the pixels.
2. It OCRs the window, groups words into rows by vertical centre, splits each row at
   its widest gap, and accepts a split only when the right side is plain integers.
3. It matches the name it read against the roster with a similarity floor, which is
   how `BIG OLDPLAYER` → `BIG_OLDPLAYER` and `moezl 5323` → `moez15323` still land
   on the right player.
4. It POSTs `stats` events (absolute K/D, never deltas) and `left` when a player has
   been absent for N consecutive scans while the rest of the board is visible.

Guards that stop it poisoning a match:

| Guard | Behaviour |
|---|---|
| board not visible | fewer than `--min-rows` players resolved → the cycle is skipped, not read as eight disconnects |
| name unclear | below the similarity floor → that player is skipped for the cycle, never guessed |
| counter going backwards | a misread digit that would decrease a value is ignored |
| host unreachable | the batch is logged and dropped, the loop keeps running |
| score | still `/result score` — the leaderboard shows per-player numbers, not round wins |

Verify it before a match, on a still:

```
python bridge/ocr-bridge.py --match m_x --url http://127.0.0.1:8099 \
    --secret s --image bridge/sample-scoreboard.png --once --dump shot.png
```

Trade-offs, stated plainly: it lags by one OCR cycle (default 3s), it needs the host's
screen with the board open, and it breaks if the leaderboard moves — `--region x,y,w,h`
fixes that without touching the recognition. It is the only route that works on a map
you have zero access to.

### Route 3 — manual referee

`/result add`, `/result score`, `/result left`, `/result end`. A human watches the
scoreboard and types. Slower, always correct, zero setup. This is the right default
until route 1 exists — it is also the reason the bot is useful on day one.

### Route 4 — pull from Open Cloud (only for a place you own)

If you own the universe and set a datastore, `config.json` has `roblox.universeId`,
`placeId`, `openCloudApiKey` reserved for polling that datastore. Not wired by default
because it needs a place you control, which route 1 already covers better.

### Recommendation

Start on **route 3** today — it works in five minutes and the boards are already
correct. Move to **route 1** the moment you have a forked place; the ingest endpoint,
the results embed and the dashboard never change. Keep **route 2** for the day you have
to run on a map you truly cannot touch.

---

## Security

The ingest endpoint is a write path into a public-facing bot, so it is treated as one:
- `X-Ingest-Secret` compared with `timingSafeEqual`, not `===`
- body capped at 64 KB
- unknown events are rejected per-item and reported, never silently accepted
- a finished match refuses new events (409/`rejected`)
- bind address is configurable; set `ingest.host` to `127.0.0.1` and put a tunnel in
  front if the bot runs on a public box

If the host must reach it over the internet, front it with the same tunnel you already
use and keep the secret long.

---

## Tests

```
npm run selftest     # 30 checks, no Discord token needed
npm run e2e:ocr      # 14 checks, drives the real Python OCR process
```

`selftest` includes a real HTTP POST against a real listening socket to prove the
ingest path authenticates, batches, writes through and refreshes the board exactly
once per batch.

`e2e:ocr` seeds a match, starts the ingest server, spawns
`bridge/ocr-bridge.py` against `bridge/sample-scoreboard.png`, and asserts what
landed in the store — kills and deaths per player, attribution of the two names OCR
mangles on purpose, idempotency on a second identical scan, `left` on a player
missing from the board, and the skip when the board is only half visible.

```
npm run selftest   ->  PASS 30   FAIL 0
npm run e2e:ocr    ->  PASS 14   FAIL 0
```

---

## Layout

```
src/
  index.js            gateway, interaction router, startup restore
  config.js           config load + "refuse to start half-configured"
  store.js            queues, matches, events, message refs (atomic JSON)
  teams.js            random / rating-balanced split, validation
  render.js           every embed and button, in one place
  queue.js            join modal, split, start, dashboards, results refresh
  ingest.js           HTTP bridge with secret check and batching
  deploy-commands.js  slash command registration
bridge/
  roblox-script.lua   the in-place script for route 1
test/
  selftest.js         30 assertions, including a live HTTP round trip
```

---

## Known limits

- Slash commands are guild-scoped: they appear only in the guild in `config.json`.
- `resultsLog` channel is reserved and not written to yet.
- The rating source for balanced split is `data/state.json → ratings`, keyed by
  lowercase Roblox name or Discord id. Nothing populates it automatically.
- Route 2 (OCR) reads what is on the host's screen: it needs the leaderboard visible,
  the game not minimised, and roughly 3 seconds per cycle. It is the only route that
  works on a place nobody on your side can edit, but it is also the only one that can
  misread — the similarity floor and the visibility guard exist for that reason.

---

## Verification and the developer portal

The ⚠ next to **App Verification** in the portal is not a gate on adding the bot to a
server. Discord's own text on that page:

> In order to scale your application past 100 servers, we require your team owner to
> complete identity and application verification.

Below 100 servers the check is informational. What it currently reports for `wave`:

| Criterion | State |
|---|---|
| app belongs to a Team | ❌ missing |
| no harmful language in name/description/commands | ✅ |
| link to Terms of Service | ❌ missing |
| link to Privacy Policy | ❌ missing |
| has an install link | ✅ |
| owner email verified + 2FA | ✅ |

So nothing blocks the install. If the server ever passes 100 guilds, the app has to
move under a Team and both links have to exist; both are fields on the General
Information page.

Adding the bot to a server is a plain OAuth2 install, not a verification step:

```
https://discord.com/api/oauth2/authorize?client_id=<app id>&permissions=115968&scope=bot%20applications.commands
```

`115968` = View Channel, Send Messages, Manage Messages, Embed Links, Attach Files,
Read Message History, Manage Channels.

## Who can run the staff commands

`config.roles.staff` empty (the default) means every member may use `/host`, `/queue`,
`/result` and `/match`. Set it to a role id and only that role, plus anyone holding
Manage Server or Administrator, gets through. The check lives in `index.js` and the
commands themselves carry no Discord-side restriction, because a scrim server usually
gives staff a custom role rather than Discord's built-in Manage Events.

