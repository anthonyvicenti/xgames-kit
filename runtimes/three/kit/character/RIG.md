# gf-humanoid-1: the games.fun character standard

Every player character is a GLB on one skeleton standard. Bodies swap freely, all bodies play the same clips, and any GLB that passes `tools/rig-check.mjs` is a valid body or skin. The data lives in `rig.js` (shared by the runtime and the tools), so this page and the code can't drift.

## 1. Space and units

| Rule | Value |
|---|---|
| Units | metres |
| Up | +Y |
| Forward | +Z (the character faces +Z) |
| Left | +X (the character's own left hand is on +X) |
| Origin | between the feet, on the ground (y = 0) |
| Height | 0.5–3 m standing (players are 1–2 m; `rig-check` warns outside 0.9–2.2) |

## 2. Bones

Names are the Mixamo-style names Meshy's auto-rig emits, so a Meshy body needs no renaming. Fingers use Mixamo names.

| Bone | Parent | Required |
|---|---|---|
| `Hips` | (root of the skeleton) | yes |
| `Spine02` | `Hips` | |
| `Spine01` | `Spine02` | |
| `Spine` | `Spine01` (the chest: it parents the neck and shoulders) | yes |
| `neck` | `Spine` | |
| `Head` | `neck` | yes |
| `head_end`, `headfront` | `Head` | |
| `LeftShoulder` | `Spine` | |
| `LeftArm` | `LeftShoulder` | yes |
| `LeftForeArm` | `LeftArm` | yes |
| `LeftHand` | `LeftForeArm` | yes |
| `LeftHand{Thumb,Index,Middle,Ring,Pinky}{1,2,3}` | `LeftHand`, then each other | |
| `LeftUpLeg` | `Hips` | yes |
| `LeftLeg` | `LeftUpLeg` | yes |
| `LeftFoot` | `LeftLeg` | yes |
| `LeftToeBase` | `LeftFoot` | |
| `Right…` | the same on the right | as left |

- **Parents.** When an optional bone is missing, a bone hangs under its nearest existing canonical ancestor. `rig-check` checks this.
- **Extra bones** are allowed: tails, ears, hair, accessories. The clips don't move them, so they ride along with their parent.
- **Fingers.** The standard's finger 1 is the knuckle (the first bone of the finger itself; the thumb's 1 sits at the wrist). Some rigs start each finger with a bone inside the palm: Quaternius bodies have `Index1` 0.028 m from the wrist on a 0.21 m hand, the knuckle at `Index2`, and a fourth bone (`Index4L`) for the last joint. `rig.js` reads that from where the joints sit, not from the names: a finger whose bone 1 is nearer the wrist than 45% of the way to its bone 2 (`PALM_FIRST`) is shifted one bone outward. Its bone 1 rides with the hand, bone 2 takes the clip's 1, bone 3 the clip's 2, and the bone after 3 the clip's 3 (`createRetarget().fingers` lists the shifted fingers, `.driver` the bone each one follows). Mapped by name, the clip's knuckle curl and spread bent the palm, and the real knuckles took the middle joints' curl: the creator's "the hand is crooked" on Token Call Centre, 2026-10-07. `gf_body` extras `gfFingers: "by-name"` turns the shift off for a rig it misreads (the regression example `crooked-hands` uses it to bring the old mapping back).
- **Other rigs** are renamed by `optimize.mjs --normalize`, which recognises:
  - Mixamo (`mixamorig:` prefix; `Spine`, `Spine1`, `Spine2` become `Spine02`, `Spine01`, `Spine`);
  - Rigify `DEF-*` (Quaternius UAL);
  - Quaternius (`Abdomen`, `Torso`, `Chest`, `UpperArm.L`, `LowerArm.L`, `Wrist.L`, `UpperLeg.L`, …).
  
  It also re-hangs bones in the standard tree and drops unweighted IK helpers. A weighted bone above the hips (Quaternius `Body`) is merged into `Hips`.
- **KayKit 1.0** (Adventurers, Skeletons; the scenic library) is renamed by `tools/lib/char-kaykit.mjs` (`KAYKIT_NAMES`: `hips`, `spine` → `Spine02`, `chest` → `Spine`, `upperarm.l` → `LeftArm`, `wrist.l` → `LeftHand`, the mitten's knuckle `hand.l` → `LeftHandMiddle1`, `toes.l` → `LeftToeBase`, …), given clavicles (`addShoulders`) and normalised at x0.75 by `research/gf-scenic/tools/art-kaykit.mjs`.

## 3. Rest pose and bone frames

- **A body may rest in any reasonable pose,** A-pose or T-pose, with any bone frames. At load, `rig.js` measures two things per bone:
  - its bind rotation `B`;
  - a swing `R` that lines the upper arm, forearm, thigh and shin up with the standard's T-pose. Hands, fingers, feet and toes inherit their parent's swing; the spine, neck, head and shoulders keep the body's own posture.
  
  The four fingers (not the thumb) also line each segment up with the clips' finger, on top of the hand's swing. A hand whose fingers rest fanned apart (Quaternius, about 18° at the knuckles) otherwise closes a fist into a loose claw. The thumb keeps the hand's swing: lined up the same way, a two-bone thumb resting at another angle (`quaternius-zombie`) bent further back.

  Each frame, `world = D · R · B`, where `D` is the clip's rotation of that bone from the T-pose. The hips move by the clip's hip offset, scaled by the body's hip height. This costs two constant quaternions per bone.
- **The bind frame is recovered from the hips:** `frame = hipsNodeWorld · IBM(hips)`, per skinned mesh. That covers files exported under a scaled or rotated armature (Quaternius), and per-mesh quantisation, where gltf-transform puts the dequantisation into each skin's IBMs.
- **Library bodies are normalised** (`optimize.mjs --normalize`). Joints have identity rest rotations, the skinned meshes sit at identity under one root node `gf_body`, and there is one skeleton.
- **`rig-check` warns** when a limb rests more than 70° from the T-pose, because lining it up stretches the skin there.
- **Leg scale.** The hips move by the clip's offset times `k`, the body's straight-leg reach (hip drop, thigh, shin and ankle height) over the standard's. A body resting with its legs apart therefore keeps its feet on the ground.
- **Body extras** (on the `gf_body` node):
  - `gfSpineBend` (0–1, default 1) damps the clip's spine and head bend relative to the hips. One-piece bodies fold at the waist otherwise, and their face slides off the body; the beans use 0.4.
  - `gfTint` and `gfTintMix` control tinting (§8).
  - `gfFaces` (optional) lists expressions, each as the material names it shows and hides: the beans carry `{ "hurt": { "show": ["face_hurt", "mouth_hurt"], "hide": ["eye_white", "eye_dark", "mouth"] } }` (eyes squeezed shut as > <, an open mouth). The `show` meshes stay hidden until `character.express(name)`; a knocked-down body shows `hurt` by itself. A body without `gfFaces` keeps one face.

## 3b. The model judge

`tools/model-judge.mjs` is how a body is judged fit to play: its face, body, arms, hands, legs and feet, at rest and in every clip (creator, 2026-10-07: "We need to look at face, body, arms, legs, hands, and feet. We also need to make sure any animation does not distort these").

| Tier | Where | What |
|---|---|---|
| measure | `tools/lib/body-judge.mjs`; in `rig-check` (so every library, generated or uploaded body) and verify check 19 (every body a game ships, with the game's own retarget) | the body posed through every clip at 6 times each, beside the clips' own skeleton: the palm stays a palm, each finger joint bends as the clip's finger does, the face moves with the head, the limbs point where the clip's do; at rest every part is there, the hands match left and right, no finger rests bent sideways, the toes point forward. Folded triangles and stretched skin are notes |
| sheet | `tools/lib/body-sheet.mjs` (real GPU, the character bench on a free port) | a contact sheet: rows are poses (rest, idle, walk, run, aim, interact, a wave and each part's worst measured moment), columns the whole body, the face, each hand and the feet |
| look | `tools/lib/body-look.mjs`; in `meshy-character` after rig-check (`GF_MODEL_LOOK=0` skips it) | Claude (Opus, about $0.10 and 10 s) reads the sheet with the clips' mannequin in the same pose beside the whole body and each hand, and grades each part none, minor or major. A major fault refuses a generated body, so the worker tries once more |

A body the measuring tier fails stays in the asset library with its failed `validated` record (rig-check), and neither the catalog nor the resolver offers it. `quaternius-zombie` was one (its thumbs rested 75° off the clips' thumb and bent back in `knockdown`) until ingest's `--fix thumbs` step re-rested them (2026-10-13, builder/art/rig/thumbs.mjs).

**Which clips (2026-10-08).** The judge measures the clips a role plays, not every clip in the file (`body-judge.mjs` `clipsFor`). The creator's roguelike lost two generated golems and two bosses to a face that stretched in `swim`, a clip no enemy of that game played:
- the player (and rig-check, the library lists): every clip but `swim`, `swim_idle`, `sit`, `crouch`, `crouch_walk` and the emotes (`NOT_PLAYED`; the kit plays none of them);
- any other role (`meshy-character --enemy`, verify check 19 for every role but `player`): what enemies play (`ENEMY_CLIPS`): `idle`, `walk`, `run`, `sprint`, `jump`, `fall`, `land`, `hit`, `hit_head`, `knockdown`, `getup`, `getup_front`, `punch` and the melee clips;
- check 19 adds, for every role, the clips the game's own code plays (`bodies-check.mjs` `clipsInCode`: `….play('x')`, `act('x')`, `anim:`/`fireAnim:`/`clip:` in rules.js and its siblings, comments and `audio.play` left out);
- `model-judge.mjs --clips a,b,c` judges exactly those, `--all-clips` every clip, `--role <role>` as that role.

The regression example `swim-only-face` holds both sides: a caller whose face stretches only in clips no enemy plays passes 19, and fails it in a game whose callers swim.

## 4. Clips (`library/clips/gf-humanoid-1.glb`)

The clip file holds the *standard skeleton*: canonical names, identity rest rotations, and UAL's T-pose proportions with the hips at 0.917 m. On it are a rotation track for every standard bone and a translation track for the hips, so any clip blends with any other. Metadata for each clip is in the `gf_humanoid_1` node's extras, `gfClips[name]`:
- `loop`;
- `layer` (`base` or `upper`);
- `duration`;
- `speed` (gait clips, m/s at the standard's size);
- `start` (get-ups: where the hips begin);
- `source`.

| Clip | From | Layer | Notes |
|---|---|---|---|
| `idle` `walk` `run` | UAL Idle_Loop, Walk_Loop, Jog_Fwd_Loop | base | walk 1.04 m/s measured; run 3.9 m/s |
| `jump` `fall` `land` | Jump_Start, Jump_Loop, Jump_Land | base | the runtime skips the jump's crouch and plays it at 1.6× |
| `hit` | Hit_Chest | upper | |
| `knockdown` | Death01 | base | falls on its back, about 0.5 m backward |
| `getup` | authored | base | from lying on the back (head toward −Z) to standing at the origin |
| `aim` | Pistol_Aim_Neutral | upper | `aim_up` and `aim_down` blend by `setAim(pitch)` |
| `carry` | authored on Idle_Loop | upper | both hands in front of the chest |
| `interact` | Interact | upper | |
| `emote_wave` `emote_cheer` | authored on Idle_Loop | base | cancelled when the character moves |

**Extra clips:**

| Clip | From |
|---|---|
| `sprint` | Sprint_Loop, 6.6 m/s |
| `getup_front` | authored, from face down |
| `hit_head` | Hit_Head |
| `throw` | Spell_Simple_Shoot (upper) |
| `punch` | Punch_Jab (upper) |
| `pickup` | PickUp_Table |
| `push` | Push_Loop |
| `crouch`, `crouch_walk` | Crouch_Idle_Loop, Crouch_Fwd_Loop |
| `roll` | Roll |
| `sit` | Sitting_Idle_Loop |
| `swim`, `swim_idle` | Swim_Fwd_Loop, Swim_Idle_Loop |
| `emote_dance` | Dance_Loop |
| `emote_talk` | Idle_Talking_Loop |

**Melee clips** (2026-10-08, gf-scenic; `rig.js` `MELEE_CLIPS`, which a clip file need not have: an older game's file still loads, and the melee mechanic falls back). From the KayKit Adventurers 1.0 Knight (Kay Lousberg, CC0; `KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0@672074b`, sha-checked), converted by `tools/lib/char-kaykit.mjs`. `impact` (metadata, seconds) is when the weapon hand moves fastest: where a swing lands.

| Clip | From (KayKit) | Layer | Notes |
|---|---|---|---|
| `slash_1` | 1H_Melee_Attack_Slice_Diagonal | base | 1.0 s, impact 0.38 s; the 1H combo's first swing |
| `slash_2` | 1H_Melee_Attack_Slice_Horizontal | base | 1.07 s, impact 0.25 s |
| `slash_3` | 1H_Melee_Attack_Stab | base | 1.6 s, impact 0.38 s; the finisher |
| `heavy` | 2H_Melee_Attack_Chop | base | 1.63 s, impact 0.82 s; an overhead slam, both hands grip |
| `dash` | Dodge_Forward | base | 0.4 s, in place (KayKit's root travel is left out) |
| `block` | Blocking | upper | loop |
| `cast` | Spellcast_Shoot | upper | 0.93 s |
| `death` | Death_A | base | 0.8 s; falls on its back and stays (play with `hold`) |
| `attack_enemy` | 1H_Melee_Attack_Chop | base | 1.07 s, impact 0.58 s; a generic enemy swing |

KayKit has no bow clip (its ranged clips aim a crossbow), so there is no `bow_shoot`. A base-layer swing replaces locomotion; `play(name, {layer: 'upper'})` swings while the legs keep walking. How a KayKit clip becomes a standard one: the KayKit rig is lined up with the standard's T-pose as a body would be (`D = W·C⁻¹`, so a KayKit body plays it back exactly); the bones KayKit lacks are filled in (Spine01 and the neck halfway, the clavicles turned toward where KayKit moves the arm roots, the fingers from UAL hands: Sword_Idle's grip on a hand that holds a weapon); the hips move by KayKit's hips over its leg reach. What is lost: KayKit moves the thighs' roots a little (up to 0.08 m in `dash`), which a rotation-only standard cannot carry. Every library body passes the model judge on the nine clips.

The file is about 0.62 MB (0.5 MB before the melee clips): rotation keys are normalised int16, and it is meshopt-compressed. `tools/retarget.mjs` rebuilds it from the pinned UAL and KayKit sources (both sha-checked); the 31 earlier clips are bit-identical to the file before the melee clips. Licence: CC0 (Quaternius, Kay Lousberg); the authored clips are games.fun's.

## 5. Sockets

`character.socket(name)` returns an `Object3D` on a bone. Its frame is aligned with the character at the standard rest pose (+Z forward, +Y up), and its scale is in metres whatever the bone's own scale. A body may place its own socket by adding an empty node named `socket_<name>` under the bone.

| Socket | Bone | Where |
|---|---|---|
| `head` | `Head` | top of the head; a hat's origin goes here |
| `hand_r`, `hand_l` | `RightHand`, `LeftHand` | the palm; +Z runs along the hand, so a held item points where the hand points |
| `back` | `Spine` | the back's surface at chest height (backpacks, tanks) |

## 6. Ragdoll

The ragdoll has 11 Rapier bodies:

| Part | Bone it drives | Shape and joint |
|---|---|---|
| `pelvis` | `Hips` | capsule to `Spine01` |
| `torso` | `Spine01` | capsule to `neck`; spherical joint at the pelvis, ±0.4 rad per axis |
| `head` | `Head` | ball; spherical joint at the neck, ±0.35 rad per axis |
| upper arms | `LeftArm`, `RightArm` | spherical joint at the shoulder, ±1.1 rad per axis |
| forearms | `LeftForeArm`, `RightForeArm` | revolute elbow, 0–143° from the knock pose |
| thighs | `LeftUpLeg`, `RightUpLeg` | spherical joint at the hip, ±0.9 rad per axis |
| shins | `LeftLeg`, `RightLeg` | revolute knee |

- **Radii** are the 70th percentile of the skin's distance to each segment, so a bean gets a fat torso and a soldier gets thin arms.
- **Joint limits** are relative to the pose the body was knocked in (Rapier's per-axis angular limits, set through the
  joint's raw set because its JS API only limits revolute joints). Free ball joints let a head spin up to 180° on the
  neck, which looked like the head tearing off the body (`character.js` `SWING`; `tests/p-character.test.mjs`).
- **Launch velocity** is the knock plus the body's own movement, which the character measures from `object3d`. A jump
  of more than 2.5 m or 40 m/s between two updates is a placement (spawn, respawn, a get-up, a first pose), not motion;
  what a ragdoll inherits is capped at 14 m/s and a part never leaves faster than 30 m/s. (Spawning at the origin, then
  being placed at a spawn point, used to read as ~300 m/s: a knock in the next frames threw the ragdoll hundreds of metres.)
- **Knocked again while down**, the ragdoll it is gets the shove; it is not rebuilt.
- **Physics shape:** `ctx.physics` may be the bare Rapier `World` (with `ctx.RAPIER`, K1's boot) or `{ RAPIER, world }`;
  it is read through `kit/core/util.js` `physicsOf(ctx)`.
- **Look:** `spawnCharacter` runs the body through `ctx.look.adoptMaterials(model, 'character')` (the house character
  material) before it clones the `tint_*` materials, and a hat through `'prop'`. Without a look, the GLB's own materials stay.
- **Collision groups** (RAPIER `InteractionGroups`, membership << 16 | filter):

  | Group | Bit |
  |---|---|
  | `WORLD` | 0x1 |
  | `PLAYERS` | 0x2 |
  | `PROPS` | 0x4 |
  | `RAGDOLL` | 0x8 |

  Ragdoll parts are members of `RAGDOLL` and collide with `WORLD | PROPS` only.
- **Getting up:**
  1. Once the ragdoll settles (fastest part under 0.35 m/s, after at least 0.7 s, at most 4 s), the character picks `getup` (on its back) or `getup_front` (face down).
  2. It turns the clip so the head points where the ragdoll's head lies.
  3. It blends from the ragdoll pose over 0.38 s.
  4. While it stands up, the model drifts from where it lay onto `object3d`, the capsule's spot.

## 7. Budget (rig-check)

| Measure | Target (warn) | Limit (fail) |
|---|---|---|
| File | 2.5 MB | 6 MB |
| Triangles | 30k | 60k |
| Texture side | 1024 px | 2048 px |
| Joints | 90 | 160 |
| Materials | 8 | 24 |

- Influences: 4 per vertex, and no `JOINTS_1`.
- `optimize.mjs` gets there:
  - textures go to 1024 px JPEG;
  - Meshy's emissive copy of the albedo is stripped;
  - quantise and meshopt (the kit's GLTFLoader has the meshopt decoder).
- KTX2 is not produced yet, because `toktx` is not installed.

## 8. Tint

- Materials named `tint_*`, or listed in the `gf_body` node's `gfTint` extras, are cloned per character. `setTint(c)` moves them toward `c` by `gfTintMix` (0–1, default 1).
- Beans and the mannequin tint fully. The SWAT body uses 0.4. A Meshy body uses 0, because its texture is its identity; the nameplate and the kit's ring carry the player's colour.

## 9. Runtime API (`character.js`)

```js
const c = await spawnCharacter(ctx, { player, bodySlot: 'character.body.player', tint, local, height, clipsSlot, plate: null | 'sprite', onState });
c.object3d                       // place it (the controller sets position and rotation.y every frame)
c.update(dt)                     // every frame, after placing it
c.locomotion(speed, grounded, vy)// idle/walk/run/sprint by speed at this body's stride; jump/fall/land from grounded and vy
c.play(name, {loop, fade, hold, rate, layer})  c.stop(name | 'upper' | 'base')  c.setAim(pitch)
c.knock({x, y, z})               // ragdoll with this velocity, then get up; ragdoll(true|false) for the controller's 'knockdown' word
c.socket('head' | 'hand_r' | 'hand_l' | 'back')   c.setTint(color)   c.nameplate(text, color)   c.dispose()
c.express('hurt', seconds)       // a face from gfFaces (§3) for a while; calling again keeps it; null for the neutral face
c.height  c.hipHeight  c.state ('anim' | 'ragdoll' | 'getup')  c.anim  c.face  c.faces  c.clips  c.meta  c.bones  c.plate {text, color}
```

`slotsFor(cfg)` declares, for each role in `config/characters.json`:

| Slot | What it is |
|---|---|
| `character.body.<role>` | model (`constraints.rig: "gf-humanoid-1"`, `animations: CLIPS`, a `generate` hint for `meshy-character.mjs`) |
| `character.tint.<role>` | colours |
| `character.height.<role>` | the height |
| `character.hat.<role>` | a hat (optional) |
| `character.clips` | the shared clips (read-only) |
