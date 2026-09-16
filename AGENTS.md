# AGENTS.md

This is the working map of the repo. Read it before changing code. Do not play the game to learn the rules; they are here. The public voice lives in `README.md`. This file is for agents.

## What it is

Umatamari is a browser Katamari. Max is a horse. Things smaller than him stick. Things bigger say nay. Timed runs last three minutes and aim for 78.2 hands. Endless has no bell. The daily field is seeded from the UTC date so everyone rolls the same world. Live site: https://max.horse

The game is a Vite + three.js r128 app on Cloudflare Pages. The Pages project is still named `maximum-horsage`. Default git branch is `master`.

## Layout

```
README.md              public pitch, run, deploy
AGENTS.md              this file
index.html             HUD, title card, end card
src/main.js            the entire game
src/style.css          HUD and cards
functions/api/max.js   king-of-the-hill GET/POST
wrangler.toml          Pages + KING KV
vite.config.js         empty Vite config
package.json           name umatamari, deploy script
```

There is no `src/sim`, no `src/props`, no tests, no CI, no D1, no auth, no community recipe folder. If another document in history says otherwise, it is stale. Ignore it.

## Run and deploy

```
npm i && npm run dev
```

`http://localhost:5173/?seed=dev` is the cheat field. `[` `]` scale Max, `T` adds 30s in timed, `Y` multiplies hp. Those mark the run `dirty`. Dirty and `seed=dev` never write the king.

```
npm run deploy
```

builds `dist` and runs `wrangler pages deploy dist --project-name maximum-horsage`.

## Architecture

One file, `src/main.js`, about 2.3k lines. Keep it that way unless the owner asks to split. Match the style already there: `var`, function declarations, no modules, no new npm dependencies.

three.js is **r128**. Old APIs (`sRGBEncoding`, `BufferGeometryUtils.mergeBufferGeometries`, `MeshLambertMaterial` vertexColors). Do not bump three.js in passing. It will break the renderer and the bake path.

World props are built, then `bakeProp` merges their meshes into one vertex-colored mesh. Max's head and tail are **not** parented to the rolling ball. They live on a scene-level `rig`. Anything welded to `katamari` spends half of each turn underground.

## Units

- A hand is 4 inches. `CM_PER_HAND = 10.16`.
- `hh = radius * 200 / CM_PER_HAND` (internal). Display says "hands" (5.3 hands means five hands three inches, not 5.3 decimal). Start radius `0.30` shows as 5.3 hands. Goal radius `GOAL_R = 4.0` shows as 78.2 hands.
- Volume fill: pickup adds `size³ * FILL` (`FILL = 0.32`). Radius is the sphere of that volume.
- Pickup: an object sticks if `size <= radius * PICKUP` (`PICKUP = 1.55`).
- **A horse is exactly 1 hp.** Recipes that are horses (`dark horse`, `police horse`, `high horse`, `trojan horse`, and any new one) must set `hp: 1`. Horsepower on Max is a running total of eaten hp. `powerMul()` uses log10(hp). It does not change FOV.

## Randomness

The field is deterministic.

- `rnd` is `mulberry32(fnv1a(SEED))`. Seed is `?seed=` or today's UTC date.
- `reseed()` on `reset()`. All spawn and recipe `make()` color/layout that should replay must use `rnd()`.
- `trnd` is a second stream (`0xC0FFEE`) for cosmetics that do not need to replay: grass texture, ball speckles, enemy placement and fire.
- `Math.random()` is allowed only for juice that is not the field: audio noise buffer, camera shake, debris spin. Do not use it in `spawnWorld`, `pickRecipeForBand`, or `KIT[].make`.

There is no `WORLD_VER` and no input log. The king endpoint trusts the client. Changing spawn, pickup, or timing invalidates old high scores in spirit even though nothing in code versions the ruleset.

## Kit and spawn

`KIT` is an array of inline recipes in `main.js`. Each has `name`, `size: [min,max]`, `w` (weight), `zone: [lo,hi]`, optional `hp`, optional `trojan`, and `make(s, color)`.

Build parts with `box` / `cyl` / `sph` / `con` / `turn` and the named colors (`HIDE`, `MANE`, `DARK`, `SOCK`, `BRASS`, `BRONZE`, `STEEL`) or `PAL` via `hue()`. World horses share `quadruped(s, hide, mane, legK)`.

`BANDS` plus `spawnWorld(1100)` carpet the bowl. Small crumbs are forced into a wide ring so the opening is playable. One trojan horse is guaranteed.

New props go in `KIT`, not a JSON folder. Keep mesh counts modest. Props are baked.

## Collision and shed

Too-big hits bounce and call `onHit`. Closing speed no longer gates *whether* something comes off. `shedFromImpact(into)` sets *how many* (`1 + floor(into/2.2)`, cap 8). `hitInvuln` (0.55s) stops a scrape from peeling every frame. Outer attachments shed first.

Nay: the word, 3-frame `hitStop`, shake, `sfxNay`, and a short white `#flash`. Flash on nay only, never on stick.

## Wanted

Timed mode has no army. `maintainEnemies()` no-ops and hides the stars.

Endless:

| hh    | stars | behaviour |
|-------|-------|-----------|
| < 16  | 0     | nothing |
| 16    | 1     | patrol, no chase |
| 21.5  | 2     | chase (record / Sampson) |
| 30    | 3     | tanks |
| 45    | 4     | heavier |
| 60    | 5     | planes |

Star 2 is "they come after you". Do not put chase back in the 3-minute game. Do not start it at pony size.

## Camera

Framing does not ease with radius. `camTier` tracks peak `TIERS` row. `dist` / `high` / `fov` snap to the *next* tier's radius (`framedRadius`) and kick 20% on level-up, then settle. Shedding does not zoom back in. Do not add a second follow mode. Do not scale FOV from hp.

`TIERS` drive HUD names and banners. `ownerCall` (speechSynthesis "max" → "MAAAAAX") fires on every displayed hands tick, not only named tiers, and the title card yells in the background. Chrome needs a tick after `cancel()` before `speak()`.

## King

`functions/api/max.js` plus KV `KING`. GET returns the current king. POST body `{ radius, hp, collected, seed }`. Rejects `dirty`, `seed === "dev"`, and non-finite junk. Keeps the row with the larger `hh`. Honor system. Endless does not submit.

## Copy

In-game UI is mixed case and already written (title card, hints, banners). Do not rewrite it to match the README. The README is all-lowercase on purpose. New player-facing strings should sound like the title card, not like a changelog.

Comments in code: lowercase, short, skip if the code is clear.

## Do not build unless asked

These were considered and left out:

- Dash (hold to spin, release to burst).
- Legs on Max. Kinematic posts and a Verlet ragdoll both got a playtest. The `legs` branch still has the ragdoll wip. Head and tail stay as they are.
- Soundtrack.
- Streaming field, late-game kit (planet scale), ground tile-follow, Verlet on Max.
- Player-request pipeline, OAuth, D1, GitHub App triage, community JSON recipes, Cursor agent launch, `WORLD_VER`, replay validation. None of that exists. Do not resurrect it from git history as if it were current.

## Other branches

- `gait` — old Muybridge runner and annotate tools. Archive. Not the game.
- `legs` — rejected ragdoll wip, local.
- Feature leftovers after squash (`play`, `field`, `juice`, …) may still exist on the remote. They are not unmerged work.

## Making a change

1. Read this file and the functions you will touch in `src/main.js`.
2. Stay inside the paths above. Do not add services.
3. If you change spawn, pickup, or timing, say so. There is no version bump, but the king is now a different game.
4. Verify in the browser. `?seed=dev` for cheats. Timed and endless if you touched mode-specific code. Title card and end card if you touched copy or king.
5. Do not commit unless asked.
