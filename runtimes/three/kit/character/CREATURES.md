# Body archetypes: worm, blob, quadruped, flyer

gf-humanoid-1 (RIG.md) is the standard for a body shaped like a person. A worm, a slime, a dog or a bird cannot look
right on it: Meshy's auto-rig put a biped skeleton on a legless critter, a hand was weighted to nothing and the face
tore in two clips (the looks pilot's moss-mole, 2026-10-14). So beside it are four more standards, one per archetype.
Each has a rig standard, a validator, procedural motion driven by the same words the humanoid clips answer, and the
same members on `p.character`, so the controller, a friend's pose over the net, fair play and every mechanic drive a
creature unchanged.

The data lives in `archetypes.js` (shared by the runtime and the Node tools), the motion in `motion.js`, the runtime
body in `creature.js`; `character.js` hands a role to it.

## 1. Space and units

The humanoid's (RIG.md §1): metres, +Y up, facing +Z, its own left on +X, the origin on the ground under the body.
A body's joints **rest unrotated in the character's axes** (identity frames; autorig writes them so) and the skinned
meshes sit under one root node `gf_body` whose extras name the standard: `{ gfRig: 'gf-blob-1', gfArchetype: 'blob' }`
(plus `gfTint`, `gfTintMix` as RIG.md §8). Heights: blob 0.2–4 m, worm 0.1–6, quadruped 0.15–5, flyer 0.1–5.

## 2. The standards

| Archetype | Rig | For | Bones (required in bold) |
|---|---|---|---|
| worm | `gf-worm-1` | a worm standing up, a snake or serpent lying down, an eel, a caterpillar | **Root**, **Seg0** (the tail end) … Seg11 in a chain (**Seg0–Seg2**), **Head** under the last segment, Jaw |
| blob | `gf-blob-1` | one round mass: a slime, a jelly, an egg-shaped critter, a puffball | **Root**, **Body** (the base, on the ground: squash pivots here), **Top** (about 55% up: it lags and jiggles), Head, LeftHand/RightHand and LeftFoot/RightFoot (nubs, under Body) |
| quadruped | `gf-quadruped-1` | four legs: a dog, a cat, a horse, a lizard | **Root**, **Hips**, Spine, **Chest**, Neck, **Head**, Jaw, LeftEar/RightEar, Tail0–2, and per leg (FrontLeft, FrontRight, BackLeft, BackRight) **UpLeg**, **Leg**, **Foot** (front legs under Chest, back legs under Hips) |
| flyer | `gf-flyer-1` | wings: a bird, a bat, a bee, a dragonling | **Root**, **Body**, Neck, **Head**, per side **Wing1**, **Wing2**, Wing3 (a chain out along ±X), Tail, LeftLeg/LeftFoot, RightLeg/RightFoot |

A missing optional bone's children hang under its nearest present ancestor (as RIG.md §2). Extra bones ride along.

**Sockets** (`character.socket(name)`, frames aligned with the character at rest): `head` on the top of the head (a
blob's Top), `hand_r`/`hand_l` (a blob's hand nubs or its sides, a quadruped's head, a flyer's feet), `back`.

## 3. Motion: the same words, procedural poses

A creature plays no clip file. Every frame `motion.js` poses its bones from what it is doing:

| Action | Words that mean it (`ACTION_OF`) | Worm | Blob | Quadruped | Flyer |
|---|---|---|---|---|---|
| idle | `idle` | slow sway, breathing | breathing squash | breathing, looking about, tail wag | standing, wings folded, head bobs (no legs: hovering) |
| move | `walk` `run` `sprint` | standing: an inching bounce up the body; lying: a side-to-side wave, the head held ahead | a waddling hop, squash at each landing, lean into the move, feet stepping | a gait (walk, trot, gallop by speed) with feet planted while down (two-bone reach), body bob, tail | hopping on its legs when slow, flying low and flapping when fast |
| air | `jump` `fall` `land` | stretched rising, curling falling | stretch rising, squash and wobble landing | front legs reach, hind legs tuck | strong flaps rising, a glide falling |
| act | `punch` `throw` `interact` `slash_*` `heavy` `attack_enemy` `cast` `pickup` | rears back, strikes | winds up (squash back), lunges (stretch forward) | crouches, then bites forward | head lunges, wings sweep |
| hit | `hit` `hit_head` | a recoil wave from the head | a squish and a jiggle | a flinch, ears flick | a ruffle |
| down | `knockdown` `death` (a knock) | tumbles as one body (Rapier), limp; without physics: falls over | tumbles (a ball), flattens | tumbles, legs loose | tumbles, wings splayed |
| celebrate | `emote_cheer` `emote_wave` `emote_dance` | a fast wiggle and a spin | hops in place, a spin, hands up | rears up, paws paddle, tail wags fast | flaps up and spins |
| hold | `aim` `carry` `block` | head tips forward | hands forward | head up | legs reach forward |

Squash and stretch keep volume (a scale of k on Y is 1/√k across). A tipped or squashed blob is lifted by exactly as
much as its rest skin would sink (a sample of its points). A limb moves by its own size, never the body's (a nub a few
centimetres across is not thrown a quarter of the body's height). Secondary motion (a blob's top, a worm's head, ears)
is a damped spring driven by the body's own acceleration.

**Knocked down**, a creature tumbles as one Rapier body (a ball for a blob, a rounded box for the rest) with the knock's
velocity, its bones going limp, then stands back up where it came to rest: `onState('getup', {position, yaw})` moves its
capsule there exactly as a humanoid's ragdoll does. Its states are the humanoid's (`'anim' | 'ragdoll' | 'getup'`), so
the controller holds the capsule still while it is down and fair play counts it down.

**Multiplayer**: a friend's copy has only the pose (position, yaw and the anim word), as for a humanoid; the word drives
the same action and the motion's own springs follow the movement, so every copy sees the same creature doing the same
thing (gate E).

## 4. Validator: the creature judge

`builder/tools/lib/creature-judge.mjs`, reached through `rig-check` (a body whose `gf_body` extras name an archetype, or
`--archetype`) and verify measure 19 (gate A, for every body slot whose constraints or file name an archetype). It
checks the standard's bones and parents, the joints resting unrotated, the scale and the archetype's facing, the skin
(every vertex weighted, sums of 1, at most four influences, every required bone leading some skin), the budget
(RIG.md §7), then poses the body through every action above with the kit's own motion (in Node) and measures its body,
head and limbs: triangles stretched past 2.2× or squeezed under 0.35× (over 2% of a part fails), triangles folding
inside out against their bone's turn (over 6%), a part flying off, sinking into the ground, never touching it while it
walks, or nothing moving when it moves.

## 5. Getting a body

- **The library**: `library/packs/xk-creature-bodies` (public, CC0, made by `runtimes/three/tools/creatures.mjs`): a
  worm standing, a snake lying, a slime, a pup, a bird. A spec names any body of the role's archetype; `create` falls
  back to the first of that archetype.
- **Auto-rig** (`builder/art/rig/autorig.mjs`; `gamesfun art autorig <mesh.glb> --archetype blob --out <body.glb>`, or
  `art ingest … --autorig blob`): a plain mesh in, a body on the standard out. It grounds and centres the mesh, fits the
  archetype's skeleton from where the vertices are (slices along a worm, ground-contact clusters for a blob's feet and
  side bumps for its hands, the belly line and four leg columns of a quadruped, the thin sheet of a flyer's wings), then
  weights each vertex by its place on that skeleton and spreads the weights a few centimetres over the mesh's own
  surface. Our own code; no outside rigging service.
- **Made art**: a creature slot made `from: "generate"` goes to Meshy as an unrigged model in a pose for its archetype
  (`builder/art/recipe.mjs` `POSE_OF`), then through ingest with `--autorig`. Meshy's own rigging is for humanoids only.

## 6. In a spec and a game

```json
"characters": [{ "role": "player", "describe": "a round critter",
  "body": { "archetype": "blob", "from": "library", "asset": "xk-creature-bodies/slime-blue" },
  "seats": [{ "archetype": "worm", "from": "library", "asset": "xk-creature-bodies/worm-pink" }] }]
```

`create` writes `config/characters.json` → `roles.player = { body, height (the body's own), archetype, seats: [{body,
height}] }`; `slotsFor` declares `character.body.player` (and `character.body.player.seat2`, …) with
`constraints: { rig: 'gf-blob-1', archetype: 'blob' }`; seat k (0-based) wears seat body k (round again when there are
more seats). A game with no humanoid role carries no clip file.
