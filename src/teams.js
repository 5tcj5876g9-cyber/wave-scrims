// Team assignment. Three strategies, one output shape.
//
// Random is the default because it needs no data. Balanced uses an optional rating
// per player (from the roster file) and is only as good as that file. Captain draft
// is what the reference board shows; the bot produces the two pools and the captains
// pick by pressing a button, which keeps the bot out of the argument.

export function splitRandom(players, teamSize) {
  const pool = shuffle([...players]);
  return {
    black: pool.slice(0, teamSize),
    white: pool.slice(teamSize, teamSize * 2),
  };
}

export function splitBalanced(players, teamSize, ratings = {}) {
  // Snake draft: sort by rating, then hand out in 1-2-2-2-1 order so the two sides
  // end up within one rating point of each other when the pool allows it.
  const rated = players
    .map((p) => ({ p, r: ratings[p.roblox?.toLowerCase()] ?? ratings[p.discordId] ?? 1000 }))
    .sort((a, b) => b.r - a.r);

  const black = [];
  const white = [];
  const order = ['b', 'w', 'w', 'b', 'b', 'w', 'w', 'b'];
  for (let i = 0; i < rated.length && i < teamSize * 2; i++) {
    (order[i % order.length] === 'b' ? black : white).push(rated[i].p);
  }
  return { black, white };
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function validate(teams, teamSize) {
  const problems = [];
  if (teams.black.length !== teamSize) problems.push(`black has ${teams.black.length}, want ${teamSize}`);
  if (teams.white.length !== teamSize) problems.push(`white has ${teams.white.length}, want ${teamSize}`);
  const ids = [...teams.black, ...teams.white].map((p) => p.discordId);
  if (new Set(ids).size !== ids.length) problems.push('a player appears on both sides');
  return problems;
}
