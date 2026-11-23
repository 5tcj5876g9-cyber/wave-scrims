--!strict
--[[
  TB Scrim Bridge — drop this into ServerScriptService of the place the scrim runs on.

  This is the only route that gives the Discord bot live, per-player, per-team data
  with no human in the loop. It requires one thing you asked about: control of the
  place. If the map is not yours, you cannot use this file — see bridge/README.md for
  the two routes that work without it.

  Setup
  -----
  1. Game Settings > Security > Allow HTTP Requests = on.
  2. Paste the two values below from your bot's config.json:
       INGEST_URL   http://<your-host>:8099/ingest/<matchId>
       SECRET       ingest.secret
     The matchId comes from the Discord reply when the host presses "Start match".
  3. Put this script in ServerScriptService and run.

  Kill attribution
  ----------------
  Roblox does not record who dealt damage. Two supported ways to give this script the
  killer, pick the one your map already uses:

    A. Weapon code tags the victim's Humanoid before applying damage:
         victimHumanoid:SetAttribute("LastAttackerUserId", attacker.UserId)
       This script reads that attribute on death. Works with any custom damage code.

    B. Weapon code calls the exposed API directly:
         require(game.ServerScriptService.TBScrimBridge):RegisterKill(attacker, victim)
       Use this if you already have a kill handler you trust.

  If neither exists, this script still reports scores and disconnects; kills will stay
  at zero and the Discord board will say so in its footer.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local INGEST_URL = "http://CHANGE-ME:8099/ingest/CHANGE-ME"
local SECRET = "CHANGE-ME-LONG-RANDOM-STRING"
local FLUSH_SECONDS = 2

-- A kill queue flushed on a timer. Sending one request per kill will hit the host's
-- rate limit in a busy scrim and stall the server thread.
local pending = {}
local bridge = {}

local function sideOf(player: Player): string?
	local team = player.Team
	if not team then return nil end
	local name = string.lower(team.Name)
	if string.find(name, "black", 1, true) then return "black" end
	if string.find(name, "white", 1, true) then return "white" end
	return nil
end

local function enqueue(event)
	table.insert(pending, event)
	if #pending > 200 then
		-- bounded: a stalled host must not grow this table forever
		table.remove(pending, 1)
	end
end

local function flush()
	if #pending == 0 then return end
	local batch = pending
	pending = {}

	local ok, err = pcall(function()
		HttpService:PostAsync(
			INGEST_URL,
			HttpService:JSONEncode(batch),
			Enum.HttpContentType.ApplicationJson,
			false,
			{ ["X-Ingest-Secret"] = SECRET }
		)
	end)

	if not ok then
		warn("[TBScrimBridge] flush failed: " .. tostring(err))
		-- Put them back so a transient network error does not lose the match.
		for _, ev in ipairs(batch) do table.insert(pending, ev) end
	end
end

function bridge:RegisterKill(attacker: Player, victim: Player)
	if not attacker or not victim then return end
	enqueue({
		type = "kill",
		killer = attacker.Name,
		victim = victim.Name,
		black = sideOf(attacker) == "black",
	})
end

function bridge:SetScore(side: string, value: number)
	enqueue({ type = "score", side = side, value = value })
end

function bridge:EndMatch(winningSide: string)
	enqueue({ type = "end", side = winningSide })
	flush()
end

-- ---------------------------------------------------------------- attribution

local function watchCharacter(player: Player, character: Model)
	local humanoid = character:WaitForChild("Humanoid", 10)
	if not humanoid then return end

	humanoid.Died:Connect(function()
		local attackerId = humanoid:GetAttribute("LastAttackerUserId")
		local killer = attackerId and Players:GetPlayerByUserId(attackerId) or nil

		if killer and killer ~= player then
			bridge:RegisterKill(killer, player)
		else
			-- No attribution available. Report the death so the board is not wrong
			-- about K/D being empty; killer is recorded as unknown.
			enqueue({ type = "kill", killer = player.Name, victim = player.Name })
		end
	end)
end

Players.PlayerAdded:Connect(function(player)
	player.CharacterAdded:Connect(function(character) watchCharacter(player, character) end)
	if player.Character then watchCharacter(player, player.Character) end
end)

Players.PlayerRemoving:Connect(function(player)
	enqueue({ type = "left", player = player.Name })
	flush() -- a disconnect is the one event worth sending immediately
end)

-- ---------------------------------------------------------------- loop

task.spawn(function()
	while true do
		task.wait(FLUSH_SECONDS)
		flush()
	end
end)

-- ---------------------------------------------------------------- score poll
-- Roblox has no event for a round win, so the map must tell us. Two supported ways:
--   1. call bridge:SetScore("black", n) from your round logic
--   2. put a NumberValue named BlackScore / WhiteScore in ReplicatedStorage and this
--      loop picks it up, which avoids editing the map's logic at all.
local rs = game:GetService("ReplicatedStorage")
local lastBlack, lastWhite = -1, -1

task.spawn(function()
	while true do
		task.wait(1)
		local b = rs:FindFirstChild("BlackScore")
		local w = rs:FindFirstChild("WhiteScore")
		if b and w and b:IsA("NumberValue") and w:IsA("NumberValue") then
			if b.Value ~= lastBlack then lastBlack = b.Value; bridge:SetScore("black", b.Value) end
			if w.Value ~= lastWhite then lastWhite = w.Value; bridge:SetScore("white", w.Value) end
		end
	end
end)

return bridge
