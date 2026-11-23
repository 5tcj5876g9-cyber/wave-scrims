#!/usr/bin/env python3
"""
OCR bridge — feeds the Discord board from a map nobody can edit.

Why this exists
---------------
The place the scrim runs on is not ours, so nothing inside it can call our endpoint.
The only thing we have is what the host can see: the Roblox window and its
leaderboard. This process captures that region, reads it with the OCR engine that
ships inside Windows 10/11 (Windows.Media.Ocr — no Tesseract, no cloud, no key),
matches what it read against the real roster it pulls from the bot, and POSTs
absolute K/D values to the same /ingest endpoint the map script would have used.

The bot already knows who is on which team, because it performed the 4v4 split.
This process only has to supply numbers, which is why the map never needs to be
instrumented and the team attribute is never guessed from pixels.

    pip install winsdk mss pillow

    python bridge/ocr-bridge.py \
        --match m_ab12cd34 \
        --url http://127.0.0.1:8099 \
        --secret "the value of ingest.secret" \
        --window Roblox

Verify it on a still image before trusting it at match time:

    python bridge/ocr-bridge.py --match m_x --url http://127.0.0.1:8099 \
        --secret s --image bridge/sample-scoreboard.png --once --dump

Known limits, stated so nobody is surprised at minute three of a scrim:
  - it reads what is on screen; if the host alt-tabs, the cycle is skipped (the row
    count guard fires) instead of reporting everyone as having left
  - a name that OCR mangles past the similarity floor is skipped for that cycle,
    never guessed
  - team score still comes from /result score, because the scoreboard shows per
    player numbers, not round wins
"""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import ctypes.wintypes as wt
import json
import re
import sys
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

from PIL import Image

# ---------------------------------------------------------------- constants

NUM_RE = re.compile(r"^\d{1,3}$")
KEEP_RE = re.compile(r"[^a-z0-9]")

# OCR reads "BIG_OLDPLAYER" as "BIG OLDPLAYER" and "moez15323" as "moezl 5323".
# After stripping non-alphanumerics those become 0 and 1 edits away, so the floor
# sits above what a genuinely different name would score.
MATCH_FLOOR = 0.82
MATCH_LEN_SLACK = 3


# ---------------------------------------------------------------- roster


def api(base: str, path: str, secret: str, method: str = "GET", body=None, timeout=8.0):
    data = None
    headers = {"X-Ingest-Secret": secret}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urlrequest.Request(
        base.rstrip("/") + path, data=data, headers=headers, method=method
    )
    with urlrequest.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def fetch_roster(base: str, match_id: str, secret: str, attempts: int = 5):
    last = None
    for i in range(attempts):
        try:
            payload = api(base, f"/match/{match_id}", secret)
            teams = payload["match"]["teams"]
            roster = []
            for side in ("black", "white"):
                for p in teams.get(side) or []:
                    if p.get("roblox"):
                        roster.append(
                            {"roblox": p["roblox"], "side": side, "tag": p.get("tag")}
                        )
            if not roster:
                raise RuntimeError("match has no players with a Roblox name yet")
            return payload["match"], roster
        except (urlerror.URLError, urlerror.HTTPError, KeyError, RuntimeError) as exc:
            last = exc
            time.sleep(min(2**i, 15))
    raise SystemExit(f"could not read the roster after {attempts} attempts: {last}")


# ---------------------------------------------------------------- capture


def enum_windows(substr: str):
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    found = []
    proc_t = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if substr.lower() in buf.value.lower():
            found.append((hwnd, buf.value))
        return True

    user32.EnumWindows(proc_t(cb), 0)
    return found


def client_region(hwnd) -> tuple[int, int, int, int]:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    rect = wt.RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("GetClientRect failed")
    origin = wt.POINT(0, 0)
    if not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        raise RuntimeError("ClientToScreen failed")
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width < 200 or height < 200:
        raise RuntimeError(f"window client area is only {width}x{height}")
    return origin.x, origin.y, width, height


def grab(region: tuple[int, int, int, int]) -> Image.Image:
    import mss

    x, y, w, h = region
    with mss.mss() as sct:
        shot = sct.grab({"left": x, "top": y, "width": w, "height": h})
    # mss hands back BGRA; PIL's raw decoder names that "BGRX" for an RGB target.
    return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


# ---------------------------------------------------------------- ocr


def make_engine(tag: str | None):
    from winsdk.windows.media.ocr import OcrEngine

    if tag:
        from winsdk.windows.globalization.language import Language

        engine = OcrEngine.try_create_from_language(Language(tag))
        if engine is None:
            raise SystemExit(f"no OCR recognizer installed for {tag}")
        return engine
    engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        raise SystemExit(
            "no OCR recognizer installed; add a language pack in Windows Settings"
        )
    return engine


async def ocr_words(engine, image: Image.Image):
    from winsdk.windows.graphics.imaging import (
        BitmapAlphaMode,
        BitmapPixelFormat,
        SoftwareBitmap,
    )
    from winsdk.windows.storage.streams import DataWriter

    rgba = image.convert("RGBA")
    w, h = rgba.size
    writer = DataWriter()
    writer.write_bytes(rgba.tobytes())
    bitmap = SoftwareBitmap.create_copy_from_buffer(
        writer.detach_buffer(),
        BitmapPixelFormat.RGBA8,
        w,
        h,
        BitmapAlphaMode.PREMULTIPLIED,
    )
    result = await engine.recognize_async(bitmap)
    words = []
    for line in result.lines:
        for word in line.words:
            r = word.bounding_rect
            words.append(
                {
                    "text": word.text.strip(),
                    "x": float(r.x),
                    "y": float(r.y),
                    "w": float(r.width),
                    "h": float(r.height),
                }
            )
    return words


# ---------------------------------------------------------------- parsing


def cluster_rows(words):
    """Group words into visual rows by vertical centre, tolerant of a one-pixel wobble."""
    rows = []
    for word in sorted(words, key=lambda w: w["y"] + w["h"] / 2):
        cy = word["y"] + word["h"] / 2
        for row in rows:
            if abs(row["cy"] - cy) <= max(6.0, word["h"] * 0.7):
                row["words"].append(word)
                row["cy"] = (row["cy"] * row["n"] + cy) / (row["n"] + 1)
                row["n"] += 1
                break
        else:
            rows.append({"cy": cy, "n": 1, "words": [word]})
    for row in rows:
        row["words"].sort(key=lambda w: w["x"])
    return [r["words"] for r in rows]


def split_row(words):
    """Split a row at its widest horizontal gap, and only accept it if the right side
    is nothing but plain integers. That rejects headers, tooltips, and chat."""
    if len(words) < 2:
        return None
    gaps = []
    for i in range(len(words) - 1):
        gap = words[i + 1]["x"] - (words[i]["x"] + words[i]["w"])
        gaps.append((gap, i))
    _gap, idx = max(gaps, key=lambda g: g[0])
    left, right = words[: idx + 1], words[idx + 1 :]
    if not right or not all(NUM_RE.match(w["text"]) for w in right):
        return None
    name = "".join(w["text"] for w in left)
    if not name:
        return None
    return name, [int(w["text"]) for w in right]


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    return KEEP_RE.sub("", value.lower())


def match_player(raw: str, roster):
    key = norm(raw)
    if len(key) < 3:
        return None, 0.0
    best, best_score = None, 0.0
    for entry in roster:
        cand = norm(entry["roblox"])
        if not cand:
            continue
        if key == cand:
            return entry, 1.0
        if abs(len(key) - len(cand)) > MATCH_LEN_SLACK:
            continue
        score = SequenceMatcher(None, key, cand).ratio()
        if score > best_score:
            best, best_score = entry, score
    if best is not None and best_score >= MATCH_FLOOR:
        return best, best_score
    return None, best_score


def parse_board(words, roster):
    """Turn OCR words into {roblox: {kills, deaths}} plus the count of rows that
    looked like a player but could not be resolved."""
    board = {}
    unmatched = []
    for row in cluster_rows(words):
        parts = split_row(row)
        if not parts:
            continue
        raw, nums = parts
        player, score = match_player(raw, roster)
        if player is None:
            unmatched.append((raw, round(score, 2)))
            continue
        kills = nums[0] if nums else 0
        deaths = nums[1] if len(nums) > 1 else 0
        prev = board.get(player["roblox"])
        if prev is None or kills > prev["kills"]:
            board[player["roblox"]] = {"kills": kills, "deaths": deaths}
    return board, unmatched


# ---------------------------------------------------------------- main loop


class Bridge:
    def __init__(self, args, roster, match):
        self.args = args
        self.roster = roster
        self.match = match
        self.state_path = (
            Path(args.state)
            if args.state
            else (
                Path(__file__).resolve().parent.parent
                / "data"
                / f"ocr-{args.match}.json"
            )
        )
        self.state = self._load_state()
        self.engine = make_engine(args.lang)

    def _load_state(self):
        if self.args.fresh or not self.state_path.exists():
            return {"seen": {}, "missing": {}, "sent_events": 0, "cycles": 0}
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:
            return {"seen": {}, "missing": {}, "sent_events": 0, "cycles": 0}

    def _save_state(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2), encoding="utf-8")
        tmp.replace(self.state_path)

    def region(self):
        if self.args.region:
            x, y, w, h = (int(v) for v in self.args.region.split(","))
            return x, y, w, h
        windows = enum_windows(self.args.window)
        if not windows:
            raise RuntimeError(f'no visible window containing "{self.args.window}"')
        return client_region(windows[0][0])

    async def capture_words(self):
        if self.args.image:
            image = Image.open(self.args.image).convert("RGB")
            region = (0, 0, image.width, image.height)
        else:
            region = self.region()
            image = grab(region)
        if self.args.dump:
            image.save(self.args.dump)
        return await ocr_words(self.engine, image), region

    async def cycle(self):
        words, region = await self.capture_words()
        board, unmatched = parse_board(words, self.roster)
        self.state["cycles"] += 1

        if len(board) < self.args.min_rows:
            # The leaderboard is not on screen: window minimised, menu open, tab out.
            # Reporting that as eight disconnects would poison the match, so skip.
            print(
                f"[ocr] only {len(board)} player row(s) resolved - board not visible, skipping"
            )
            if unmatched:
                print(f"[ocr]   unresolved: {unmatched[:4]}")
            return

        events = []
        seen = self.state["seen"]
        for roblox, values in board.items():
            prev = seen.get(roblox)
            if (
                prev
                and prev["kills"] == values["kills"]
                and prev["deaths"] == values["deaths"]
            ):
                continue
            events.append(
                {
                    "type": "stats",
                    "player": roblox,
                    "kills": values["kills"],
                    "deaths": values["deaths"],
                }
            )
            seen[roblox] = values
            self.state["missing"][roblox] = 0

        present = set(board)
        for roblox in [p["roblox"] for p in self.roster]:
            if roblox in present:
                continue
            count = self.state["missing"].get(roblox, 0) + 1
            self.state["missing"][roblox] = count
            if count == self.args.missing_scans:
                events.append({"type": "left", "player": roblox})
                print(f"[ocr] {roblox} missing for {count} scans -> marked as left")

        if events:
            self._post(events)
        self._save_state()

        summary = ", ".join(
            f"{k}:{v['kills']}/{v['deaths']}" for k, v in list(board.items())[:4]
        )
        print(
            f"[ocr] {len(board)} rows @ {region[0]},{region[1]} {region[2]}x{region[3]} "
            f"| sent {len(events)} | {summary}"
        )

    def _post(self, events):
        try:
            result = api(
                self.args.url,
                f"/ingest/{self.args.match}",
                self.args.secret,
                method="POST",
                body=events,
            )
            self.state["sent_events"] = self.state.get("sent_events", 0) + result.get(
                "accepted", 0
            )
            if result.get("rejected"):
                print(
                    f"[ocr] server rejected {result['rejected']}: {result.get('detail')}"
                )
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:200]
            print(f"[ocr] POST {exc.code}: {detail}")
        except urlerror.URLError as exc:
            print(f"[ocr] POST failed: {exc.reason}")

    async def run(self):
        if self.args.once:
            await self.cycle()
            return
        print(
            f"[ocr] match {self.args.match} | {len(self.roster)} players | "
            f"every {self.args.interval}s | ctrl-c to stop"
        )
        while True:
            started = time.monotonic()
            try:
                await self.cycle()
            except RuntimeError as exc:
                print(f"[ocr] {exc}")
            except Exception as exc:  # a bad frame must not end the match
                print(f"[ocr] cycle error: {type(exc).__name__}: {exc}")
            elapsed = time.monotonic() - started
            await asyncio.sleep(max(0.2, self.args.interval - elapsed))


def main():
    p = argparse.ArgumentParser(
        description="Read a Roblox leaderboard and feed the scrim board"
    )
    p.add_argument(
        "--match", required=True, help="match id from the 'Start match' reply"
    )
    p.add_argument("--url", default="http://127.0.0.1:8099", help="bot ingest base url")
    p.add_argument("--secret", default=None, help="ingest.secret from config.json")
    p.add_argument(
        "--window", default="Roblox", help="window title substring to capture"
    )
    p.add_argument(
        "--region", default=None, help="x,y,w,h override instead of --window"
    )
    p.add_argument(
        "--image", default=None, help="read a still image instead of the screen"
    )
    p.add_argument(
        "--dump", default=None, help="save the captured frame here for eyeballing"
    )
    p.add_argument("--interval", type=float, default=3.0)
    p.add_argument(
        "--min-rows",
        type=int,
        default=3,
        help="below this, treat the board as not visible",
    )
    p.add_argument("--missing-scans", type=int, default=3)
    p.add_argument("--lang", default=None, help="OCR language tag, e.g. en-US")
    p.add_argument("--state", default=None)
    p.add_argument("--fresh", action="store_true", help="ignore saved state")
    p.add_argument("--once", action="store_true")
    args = p.parse_args()

    if not args.secret:
        raise SystemExit("--secret is required (it is ingest.secret in config.json)")

    match, roster = fetch_roster(args.url, args.match, args.secret)
    if match.get("status") == "done":
        raise SystemExit(f"match {args.match} is already finished")

    bridge = Bridge(args, roster, match)
    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        print("\n[ocr] stopped")


if __name__ == "__main__":
    sys.exit(main())
