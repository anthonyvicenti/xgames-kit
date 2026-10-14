//! The shared components (ARCHITECTURE.md "Components"): the only hecs components forge-core defines. Every other crate
//! defines its own components in its own crate (any `Send + Sync + 'static` type is a hecs component), so tracks F, A
//! and S never edit this file to add state. These are the ones more than one crate reads.
//!
//! Units: metres, seconds, radians (degrees only where a table value says so). Up is +Y. A yaw of 0 looks down −Z
//! (a camera's; the JS kit's character yaw faces +Z, host.js `toCoreYaw` turns one into the other).
use glam::{Mat4, Quat, Vec3};

/// Where an entity is, with the pose it had before the current fixed step, so a frame between two steps can be drawn
/// in between (render interpolation, `interpolated`). Systems write `pos` and `rot`; the core copies them into
/// `prev_*` at the start of every step. `teleport` moves without interpolating across the jump. An entity faces −Z
/// turned by `rot` (`Quat::from_rotation_y(yaw)` with the core's yaw); a gf-humanoid-1 body faces +Z, so the
/// renderer draws it turned by π. A player's `pos` is its feet and its `rot` follows its look (`core.move`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    pub pos: Vec3,
    pub rot: Quat,
    pub scale: f32,
    pub prev_pos: Vec3,
    pub prev_rot: Quat,
}

impl Default for Transform {
    fn default() -> Self {
        Self::at(Vec3::ZERO)
    }
}

impl Transform {
    pub fn at(pos: Vec3) -> Self {
        Self { pos, rot: Quat::IDENTITY, scale: 1.0, prev_pos: pos, prev_rot: Quat::IDENTITY }
    }
    pub fn with_rot(pos: Vec3, rot: Quat) -> Self {
        Self { pos, rot, scale: 1.0, prev_pos: pos, prev_rot: rot }
    }
    /// Facing a yaw (the core's: 0 looks down −Z).
    pub fn facing(pos: Vec3, yaw: f32) -> Self {
        Self::with_rot(pos, Quat::from_rotation_y(yaw))
    }
    /// Move there now, with nothing drawn in between (a spawn, a respawn, a teleport).
    pub fn teleport(&mut self, pos: Vec3) {
        self.pos = pos;
        self.prev_pos = pos;
        self.prev_rot = self.rot;
    }
    /// The start of a fixed step: the pose now becomes the one interpolated from.
    pub fn begin_step(&mut self) {
        self.prev_pos = self.pos;
        self.prev_rot = self.rot;
    }
    /// The pose `alpha` (0..1) of the way from the previous step to this one.
    pub fn interpolated(&self, alpha: f32) -> (Vec3, Quat) {
        (self.prev_pos.lerp(self.pos, alpha), self.prev_rot.slerp(self.rot, alpha))
    }
    pub fn matrix(&self) -> Mat4 {
        Mat4::from_scale_rotation_translation(Vec3::splat(self.scale), self.rot, self.pos)
    }
    pub fn matrix_at(&self, alpha: f32) -> Mat4 {
        let (p, r) = self.interpolated(alpha);
        Mat4::from_scale_rotation_translation(Vec3::splat(self.scale), r, p)
    }
}

/// How an entity moves. For a character (`Mover`) `linear` is the velocity it wants this step (the movement system
/// writes it, the character controller resolves it against the world and writes back what happened); for a dynamic
/// body the physics step writes both.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Velocity {
    pub linear: Vec3,
    pub angular: Vec3,
}

/// A player: `id` comes from the JS host (1..=255, a seat's number in the core; `snapshot` sends it as a byte).
/// `local`: this copy's own player (its eyes are the camera). `owned`: simulated on this copy. Live co-op (`net`): on
/// the host every player is owned (its own `local`; each joiner's from the inputs that joiner sends: owned, not local,
/// so give it everything but the camera); on a joiner only its own player is (predicted, then reconciled) and the
/// others are `Replica`s from the host's snapshots. Wave 4, a viewer (`net::Role::Viewer`): no player is owned, and the
/// one it watches is `local` (`net.watch`): local and not owned is "this copy looks through its eyes and simulates
/// nothing of it", so a system that acts for this copy's own player asks for `local && owned`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Player {
    pub id: u32,
    pub local: bool,
    pub owned: bool,
}

/// Where a player looks (the core's yaw and pitch). Looking is applied at the frame rate, when the INPUT command
/// arrives, never held back to the next step.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Look {
    pub yaw: f32,
    pub pitch: f32,
}

/// A player's buttons and stick. `held`: down now (cmd::BTN_*). `pressed`: went down since the last step that ran
/// (latched, so a press in a frame that runs no step is not lost; the core clears it after each step). `enabled`
/// false: the stick and buttons read as idle (a menu over the game).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Control {
    pub move_x: f32,
    pub move_z: f32,
    pub held: u32,
    pub pressed: u32,
    pub enabled: bool,
}

impl Control {
    pub fn down(&self, b: u32) -> bool {
        self.enabled && self.held & b != 0
    }
    pub fn pressed(&self, b: u32) -> bool {
        self.enabled && self.pressed & b != 0
    }
}

/// Hit points. `armor` absorbs damage first. `dead` is set once by whoever kills (`Sim::damage`), never cleared but by a
/// respawn. `invulnerable`: seconds left during which damage is ignored (an evade's frames, a respawn).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Health {
    pub hp: f32,
    pub max: f32,
    pub armor: f32,
    pub dead: bool,
    pub invulnerable: f32,
    /// The net id of whoever hit last (0: nobody).
    pub last_hit_by: u32,
}

impl Health {
    pub fn new(max: f32) -> Self {
        Self { hp: max, max, armor: 0.0, dead: false, invulnerable: 0.0, last_hit_by: 0 }
    }
    pub fn fraction(&self) -> f32 {
        if self.max > 0.0 { (self.hp / self.max).clamp(0.0, 1.0) } else { 0.0 }
    }
}

/// Which side an entity is on. Damage between members of one team is the rules' choice (`Sim::damage` does not
/// check it; weapons and AI do).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Team(pub u8);

impl Team {
    pub const PLAYERS: Team = Team(0);
    pub const ENEMIES: Team = Team(1);
    pub const NEUTRAL: Team = Team(2);
}

/// What an entity is, for the views, the snapshot and the JS host. `type_` is the row of its table (an enemy's row in
/// `tables.enemies`, a weapon's in `tables.weapons`), or 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Kind {
    pub kind: u8,
    pub type_: u16,
}

pub mod kind {
    pub const PLAYER: u8 = 1;
    pub const ENEMY: u8 = 2;
    pub const PROJECTILE: u8 = 3;
    pub const DEBRIS: u8 = 4;
    pub const PICKUP: u8 = 5;
    pub const PROP: u8 = 6;
    /// 16..=31: a plugin's own kinds (ARCHITECTURE.md "Reserved numbers").
    pub const PLUGIN_FIRST: u8 = 16;
}

/// The id an entity has across the boundary and the network: in events, the views, the snapshot. Players keep their
/// player id (1..=255); everything else gets one from 256 up (`Sim::net_id`), at most 65535 (the snapshot's u16).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NetId(pub u32);

/// Seconds until the entity is despawned (debris, projectiles, flashes kept as entities). The core's `core.lifetime`
/// system counts it down every step and despawns at zero.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lifetime {
    pub left: f32,
}

/// A part of a humanoid body that a hit lands on (the gf-humanoid-1 ragdoll parts, RIG.md §6). Hit events carry it,
/// so a reaction, a sever or a damage multiplier knows where the hit was.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Part {
    Body = 0,
    Pelvis = 1,
    Torso = 2,
    Head = 3,
    UpperArmL = 4,
    ForearmL = 5,
    UpperArmR = 6,
    ForearmR = 7,
    ThighL = 8,
    ShinL = 9,
    ThighR = 10,
    ShinR = 11,
}

impl Part {
    pub fn from_u8(v: u8) -> Part {
        use Part::*;
        [Body, Pelvis, Torso, Head, UpperArmL, ForearmL, UpperArmR, ForearmR, ThighL, ShinL, ThighR, ShinR].get(v as usize).copied().unwrap_or(Body)
    }
    pub fn name(self) -> &'static str {
        ["body", "pelvis", "torso", "head", "upperarm_l", "forearm_l", "upperarm_r", "forearm_r", "thigh_l", "shin_l", "thigh_r", "shin_r"][self as usize]
    }
}

/// No bone: a hurt region attached to the entity's own transform.
pub const NO_BONE: u16 = u16::MAX;

/// One capsule a hit can land on, attached to a bone (`bone`: the joint index in the entity's animated body, or
/// `NO_BONE`). `a` and `b` are the capsule's ends in the bone's frame (or the entity's, with no bone), metres.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HurtRegion {
    pub part: Part,
    pub bone: u16,
    pub a: Vec3,
    pub b: Vec3,
    pub radius: f32,
    /// Damage is multiplied by this (a head at 2.0).
    pub damage: f32,
    /// A hit here is a critical hit.
    pub crit: bool,
}

/// The capsules a hit can land on (bone-attached, so they follow the animation). `world` holds each region's ends in
/// world space, placed every step by `core.hurtboxes` (after animation): rays test against it (`Sim::raycast`).
#[derive(Clone, Debug, PartialEq)]
pub struct Hurtbox {
    pub regions: Vec<HurtRegion>,
    pub world: Vec<(Vec3, Vec3)>,
    /// The collision group a trace must name to hit these (`physics::groups::ENEMY` or `PLAYER`).
    pub group: u32,
}

impl Hurtbox {
    pub fn new(regions: Vec<HurtRegion>, group: u32) -> Self {
        let n = regions.len();
        Self { regions, world: vec![(Vec3::ZERO, Vec3::ZERO); n], group }
    }
    /// One upright capsule from the feet to `height` (no bones): what an entity without a skeleton is hit on.
    pub fn upright(radius: f32, height: f32, group: u32) -> Self {
        let r = radius.min(height * 0.5);
        Self::new(vec![HurtRegion { part: Part::Body, bone: NO_BONE, a: Vec3::new(0.0, r, 0.0), b: Vec3::new(0.0, height - r, 0.0), radius: r, damage: 1.0, crit: false }], group)
    }
}

/// What a player's body wears and holds, for whoever draws it (track S sets it; track R draws it; CONTRACT §8 forge
/// "Live co-op"). Each copy sets `tint`, `body` and `hidden` for every player it knows (the boot: the player's colour or
/// their loadout's, the body slot, hidden for this copy's own first-person player); `held` is the core's (the slot keys
/// 1–4 and the wheel choose a weapons-table row, `core.held`; forge-feel may set it itself) and travels in snapshots.
///
/// The renderer draws every entity with `Wear` and an `Animated` animator as a skinned instance of the model in slot
/// `body` (the boot's slot table index), tinted, never when `hidden`; `players.js` places the held weapon's model at
/// the body's `hand_r` bone. Until the renderer draws skinned bodies (forge-web `draws_bodies()`), `players.js` draws
/// an unskinned stand-in of the same body in its bind pose.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wear {
    /// The body's colour (linear RGB): the player's seat colour, or their loadout's.
    pub tint: [f32; 3],
    /// The body's slot index (`NO_SLOT`: none).
    pub body: u32,
    /// The weapons-table row in hand (`HELD_NONE`: nothing).
    pub held: u8,
    /// Not drawn on this copy (its own first-person player).
    pub hidden: bool,
}

pub const NO_SLOT: u32 = u32::MAX;
pub const HELD_NONE: u8 = 255;

impl Default for Wear {
    fn default() -> Self {
        Self { tint: [1.0; 3], body: NO_SLOT, held: HELD_NONE, hidden: false }
    }
}

/// An entity that is this copy's own and never in a snapshot (the wave 1b integration): a kill's debris pieces, a coin,
/// a player's own round in flight. Every copy makes its own from the events it sees (a joiner bursts a kill's pieces
/// when the host's KILL arrives), so a fight's debris never crowds the 2600-byte snapshot. `Sim::spawn_local` adds it,
/// with a net id from the local range (`sim::LOCAL_NET_ID`..), which the host's actors never use.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Local;

/// Its owner plays its own hit reaction (forge-ai's enemies: a spring on the bone hit and the hit clip for the side it
/// came from), so forge-feel's flinch leaves its bones alone (one reaction a hit, not two).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Reacts;

/// Wave 7 (track E): what a plugin marks an entity with for its life (forge-ai's elites). `mark`: seven bits the
/// snapshot carries in an actor's flags byte (bits 1..7, no byte more), so every copy draws it the same (forge-ai: the
/// elite modifier, + 8 a split one's young); `taken`: the share of every hit it takes (`Sim::damage` deals
/// `amount × taken`, its HIT says what was dealt); `bounty`: what its kill pays against its row's own (forge-feel's
/// coins). A joiner's copy has the mark only (taken and bounty 1: the host decides both). Absent: 0, 1, 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Marked {
    pub mark: u8,
    pub taken: f32,
    pub bounty: f32,
}

impl Marked {
    pub const MAX_MARK: u8 = 127;
}

/// An entity this copy shows from the host's snapshots (a joiner's copy of an enemy or another player's projectile):
/// nothing simulates it here; `core.replicas` moves it between the last two snapshots.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Replica {
    pub from: Vec3,
    pub to: Vec3,
    pub from_yaw: f32,
    pub to_yaw: f32,
    /// Seconds since `to` arrived.
    pub t: f32,
    /// Seconds between the last two snapshots.
    pub span: f32,
    /// Its velocity on the host between the last two samples (m/s; zero until the second). A joiner's copy of an
    /// enemy is drawn between its samples, a little in the past; what its own player bumps into is where the host will
    /// have it when the host replays this step's input (`core.replicas`: `to + vel × the joiner's lead`).
    pub vel: Vec3,
    /// A player's look up and down at the last two samples (wave 4: a viewer's camera is a replica's eyes, and turns
    /// between its samples as the body moves between them; `snapshot::replica_look`).
    pub from_pitch: f32,
    pub to_pitch: f32,
}

impl Replica {
    /// A replica standing at its first sample.
    pub fn at(pos: Vec3, yaw: f32) -> Self {
        Self { from: pos, to: pos, from_yaw: yaw, to_yaw: yaw, t: 0.0, span: 0.0, vel: Vec3::ZERO, from_pitch: 0.0, to_pitch: 0.0 }
    }
    /// How far between its last two samples it is, `back` seconds ago (0..1).
    pub fn share(&self, back: f32) -> f32 {
        if self.span > 0.0 { ((self.t - back) / self.span).clamp(0.0, 1.0) } else { 1.0 }
    }
    /// Its look up and down now, drawn `alpha` of the way from the step before to the last one (as `Transform` is).
    pub fn pitch_at(&self, alpha: f32) -> f32 {
        let at = |k: f32| self.from_pitch + (self.to_pitch - self.from_pitch) * k;
        let (a, b) = (at(self.share(crate::STEP)), at(self.share(0.0)));
        a + (b - a) * alpha.clamp(0.0, 1.0)
    }
}

/// A player's look turns this share of what its input asks (wave 2: a downed player looks round slowly). Absent: 1.
/// The INPUT command honours it on the copy that reads the player's mouse (the look travels to the host as it is).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LookScale(pub f32);
