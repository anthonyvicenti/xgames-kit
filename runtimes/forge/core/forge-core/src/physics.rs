//! Physics (ARCHITECTURE.md "Physics"): rapier3d 0.36 (Apache-2.0) under one struct, with what the tracks need named
//! once: collision groups, static world colliders, a kinematic character controller (steps, slopes, ground snap) for
//! players and enemies, dynamic bodies for debris and ragdoll pieces, ray and shape queries, and the contacts of the
//! last step. Rapier's own sets stay public (`Physics::world`) for whatever this layer does not cover (joints for a
//! ragdoll: track F), and `forge_core::rapier3d` is the same version.
//!
//! Every collider carries its entity (`user_data` = the hecs entity's bits; 0 for the world), so a hit says what it
//! hit. Colliders the world adds are queryable at once (`refresh`, run by the core before the first query of a step).
use std::sync::Mutex;

use glam::{Quat, Vec3};
use hecs::Entity;
use rapier3d::control::{CharacterAutostep, CharacterLength, KinematicCharacterController};
use rapier3d::geometry::{InteractionTestMode, Ray};
use rapier3d::parry::query::details::ShapeCastOptions;
use rapier3d::prelude::*;

/// Collision groups (bits). A collider is a member of one; `filter_of` says what it touches by default; a query names
/// the groups it hits (`QueryMask`).
pub mod groups {
    /// Level geometry: floors, walls, props that never move.
    pub const WORLD: u32 = 1 << 0;
    pub const PLAYER: u32 = 1 << 1;
    pub const ENEMY: u32 = 1 << 2;
    /// Pieces flying after a kill, ragdoll parts.
    pub const DEBRIS: u32 = 1 << 3;
    /// Projectiles that are bodies (most are swept queries and never collide as bodies).
    pub const PROJECTILE: u32 = 1 << 4;
    /// Sensors: pickups, zones (touched, never blocking).
    pub const TRIGGER: u32 = 1 << 5;
    pub const ALL: u32 = u32::MAX;
    /// Whatever stops a character walking: the world and other bodies (not debris, which it pushes through).
    pub const CHARACTER_BLOCKS: u32 = WORLD | PLAYER | ENEMY;
    /// What stops a player walking: the world and enemies. Friends walk through each other (wave 2): a joiner's copy
    /// shows a friend a few steps behind where the host has them, so two players pushing against each other disagreed
    /// on every copy and were corrected (up to 0.98 m, track S's numbers); enemies still stop at a player.
    pub const PLAYER_BLOCKS: u32 = WORLD | ENEMY;

    /// What a member of `group` touches as a body.
    pub fn filter_of(group: u32) -> u32 {
        match group {
            WORLD => ALL,
            PLAYER => WORLD | ENEMY | DEBRIS | TRIGGER,
            ENEMY => WORLD | PLAYER | ENEMY | DEBRIS | TRIGGER,
            DEBRIS => WORLD | PLAYER | ENEMY | DEBRIS,
            PROJECTILE => WORLD | PLAYER | ENEMY,
            TRIGGER => PLAYER | ENEMY,
            _ => ALL,
        }
    }
}

/// An entity's body in the physics world.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Body {
    pub body: RigidBodyHandle,
    pub collider: ColliderHandle,
    pub kind: BodyKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyKind {
    /// Moved by the character controller (`Mover`), kinematic.
    Character,
    /// Moved by the physics step (debris, ragdoll pieces).
    Dynamic,
    /// Moved by a system setting its pose each step.
    Kinematic,
}

/// A character's controller state and shape (players and walking enemies). The movement system writes `Velocity`;
/// `core.character` resolves it here against everything in `blocks` and writes back where it went.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mover {
    pub radius: f32,
    pub half_height: f32,
    pub step_height: f32,
    /// The steepest slope walked up, radians.
    pub slope_max: f32,
    /// How far down the ground holds the character, m (0: never).
    pub snap: f32,
    /// The groups that stop it (`groups::CHARACTER_BLOCKS`).
    pub blocks: u32,
    pub grounded: bool,
    pub was_grounded: bool,
    pub ground_normal: Vec3,
    /// It hit something above this step.
    pub ceiling: bool,
    /// The normal of the steepest wall it slid along this step (zero: none) and its speed into it.
    pub wall: Vec3,
    pub wall_speed: f32,
    /// What it moved by in the last step.
    pub moved: Vec3,
    /// Extra travel this step on top of `Velocity × STEP`, metres (exact gravity integration; a dash's root motion).
    /// `core.character` uses it once and zeroes it.
    pub nudge: Vec3,
    /// A member of a crowd (wave 3: forge-ai's enemies that do not climb): on flat ground it walks by crowd.rs (other
    /// characters as discs, one sweep against the world, one ray for the ground) and through the controller only
    /// where that does not hold (in the air, a slope, a step).
    pub crowd: bool,
}

impl Mover {
    pub fn new(radius: f32, half_height: f32) -> Self {
        Self { radius, half_height, step_height: 0.35, slope_max: 46f32.to_radians(), snap: 0.25, blocks: groups::CHARACTER_BLOCKS, grounded: false, was_grounded: false, ground_normal: Vec3::Y, ceiling: false, wall: Vec3::ZERO, wall_speed: 0.0, moved: Vec3::ZERO, nudge: Vec3::ZERO, crowd: false }
    }
    /// The capsule's centre for feet at `feet`.
    pub fn center(&self, feet: Vec3) -> Vec3 {
        feet + Vec3::Y * (self.half_height + self.radius)
    }
    pub fn feet(&self, center: Vec3) -> Vec3 {
        center - Vec3::Y * (self.half_height + self.radius)
    }
}

/// What the character controller did with one step's movement.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CharacterMove {
    pub translation: Vec3,
    pub grounded: bool,
    pub sliding: bool,
    pub ceiling: bool,
    pub wall: Vec3,
    pub ground_normal: Vec3,
}

/// Which colliders a query hits: `hits` (groups), minus one entity's own (`exclude`), sensors only if `sensors`.
#[derive(Clone, Copy, Debug)]
pub struct QueryMask {
    pub hits: u32,
    pub exclude: Option<Entity>,
    /// The excluded entity's body, when the caller knows it (saves a search: `Sim::trace` fills it from `Body`).
    pub exclude_body: Option<RigidBodyHandle>,
    pub sensors: bool,
}

impl QueryMask {
    pub fn new(hits: u32) -> Self {
        Self { hits, exclude: None, exclude_body: None, sensors: false }
    }
    pub fn excluding(mut self, e: Entity) -> Self {
        self.exclude = Some(e);
        self
    }
}

/// A ray or shape hit: what (`entity`: None for the world), where, which way the surface faces, its groups.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RayHit {
    pub entity: Option<Entity>,
    pub collider: ColliderHandle,
    /// Metres along the ray (the shape's travel for a shape cast).
    pub dist: f32,
    pub point: Vec3,
    pub normal: Vec3,
    pub groups: u32,
}

/// Two colliders that started touching in the last step (only colliders built with `ActiveEvents::COLLISION_EVENTS`
/// report: every dynamic body `add_dynamic` makes does). `speed`: their relative speed then, m/s.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Contact {
    pub a: Option<Entity>,
    pub b: Option<Entity>,
    pub groups_a: u32,
    pub groups_b: u32,
    pub speed: f32,
}

/// A shape for bodies and casts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    Ball(f32),
    /// Half extents.
    Cuboid(Vec3),
    /// Upright: half the height of the straight part, and the radius.
    Capsule { half_height: f32, radius: f32 },
}

impl Shape {
    fn shared(self) -> SharedShape {
        match self {
            Shape::Ball(r) => SharedShape::ball(r.max(0.001)),
            Shape::Cuboid(h) => SharedShape::cuboid(h.x.max(0.001), h.y.max(0.001), h.z.max(0.001)),
            Shape::Capsule { half_height, radius } => SharedShape::capsule_y(half_height.max(0.0), radius.max(0.001)),
        }
    }
}

pub fn entity_bits(e: Entity) -> u128 {
    e.to_bits().get() as u128
}
pub fn entity_of_bits(b: u128) -> Option<Entity> {
    if b == 0 { None } else { Entity::from_bits(b as u64) }
}

fn igroups(member: u32, filter: u32) -> InteractionGroups {
    InteractionGroups::new(Group::from_bits_retain(member), Group::from_bits_retain(filter), InteractionTestMode::And)
}

/// Started contacts, gathered while rapier steps.
#[derive(Default)]
struct Collector {
    started: Mutex<Vec<Contact>>,
}

impl EventHandler for Collector {
    fn handle_collision_event(&self, bodies: &RigidBodySet, colliders: &ColliderSet, event: CollisionEvent, _pair: Option<&ContactPair>) {
        let CollisionEvent::Started(h1, h2, _) = event else { return };
        let (Some(c1), Some(c2)) = (colliders.get(h1), colliders.get(h2)) else { return };
        let vel = |c: &Collider| c.parent().and_then(|b| bodies.get(b)).map(|b| b.linvel()).unwrap_or(Vec3::ZERO);
        let contact = Contact { a: entity_of_bits(c1.user_data), b: entity_of_bits(c2.user_data), groups_a: c1.collision_groups().memberships.bits(), groups_b: c2.collision_groups().memberships.bits(), speed: (vel(c1) - vel(c2)).length() };
        if let Ok(mut v) = self.started.lock() {
            v.push(contact);
        }
    }
    fn handle_contact_force_event(&self, _dt: f32, _bodies: &RigidBodySet, _colliders: &ColliderSet, _pair: &ContactPair, _f: f32) {}
    fn handle_soft_body_tear_event(&self, _s: &SoftBodySet, _e: &SoftBodyTearEvent) {}
}

pub struct Physics {
    /// Rapier's whole state (bodies, colliders, joints, the pipeline). Reach in for anything this layer lacks.
    pub world: PhysicsWorld,
    /// Contacts that started in the last step.
    pub contacts: Vec<Contact>,
    statics: Vec<ColliderHandle>,
    dirty: bool,
    /// Bodies inserted since the last step: `refresh` (rapier's collision pipeline) consumes their insertion without
    /// giving them an island, so `step` touches them again first (else a body added between steps, such as a joiner's
    /// replica, sits outside every island: rapier 0.36 asserts in debug, and in release it misses a step's update).
    fresh: Vec<RigidBodyHandle>,
    collector: Collector,
}

impl Default for Physics {
    fn default() -> Self {
        Self::new()
    }
}

impl Physics {
    pub fn new() -> Self {
        let mut world = PhysicsWorld::new();
        world.integration_parameters.dt = crate::STEP;
        world.gravity = Vec3::new(0.0, -18.0, 0.0);
        Self { world, contacts: Vec::new(), statics: Vec::new(), dirty: false, fresh: Vec::new(), collector: Collector::default() }
    }

    pub fn set_gravity(&mut self, g: f32) {
        self.world.gravity = Vec3::new(0.0, -g, 0.0);
    }

    // ---- the world's static colliders ----

    /// A static box from `min` to `max` (the world's walls, floors, props).
    pub fn add_box(&mut self, min: Vec3, max: Vec3) -> ColliderHandle {
        let (lo, hi) = (min.min(max), min.max(max));
        let c = ColliderBuilder::cuboid(((hi.x - lo.x) * 0.5).max(0.001), ((hi.y - lo.y) * 0.5).max(0.001), ((hi.z - lo.z) * 0.5).max(0.001)).translation((lo + hi) * 0.5).collision_groups(igroups(groups::WORLD, groups::ALL)).build();
        self.add_static(c)
    }

    /// A static triangle mesh (a level's floor and ramps, a ruin). → Err when the mesh is empty or broken.
    pub fn add_mesh(&mut self, vertices: Vec<Vec3>, triangles: Vec<[u32; 3]>) -> Result<ColliderHandle, String> {
        if vertices.is_empty() || triangles.is_empty() {
            return Err("an empty mesh".into());
        }
        if triangles.iter().flatten().any(|&i| i as usize >= vertices.len()) {
            return Err("a triangle points past the vertices".into());
        }
        let b = ColliderBuilder::trimesh(vertices, triangles).map_err(|e| format!("not a usable mesh: {e:?}"))?;
        Ok(self.add_static(b.collision_groups(igroups(groups::WORLD, groups::ALL)).build()))
    }

    fn add_static(&mut self, c: Collider) -> ColliderHandle {
        let h = self.world.colliders.insert(c);
        self.statics.push(h);
        self.dirty = true;
        h
    }

    /// Remove every static collider the world added.
    pub fn clear_static(&mut self) {
        for h in std::mem::take(&mut self.statics) {
            self.world.remove_collider(h);
        }
        self.dirty = true;
    }

    pub fn static_count(&self) -> usize {
        self.statics.len()
    }

    // ---- bodies ----

    /// A character's kinematic capsule (feet at `feet`) in `group` (PLAYER or ENEMY).
    pub fn add_character(&mut self, e: Entity, feet: Vec3, mover: &Mover, group: u32) -> Body {
        let center = mover.center(feet);
        let rb = RigidBodyBuilder::kinematic_position_based().translation(center).user_data(entity_bits(e)).build();
        let body = self.world.bodies.insert(rb);
        self.fresh.push(body);
        let c = ColliderBuilder::capsule_y(mover.half_height, mover.radius).collision_groups(igroups(group, groups::filter_of(group))).user_data(entity_bits(e)).build();
        let collider = self.world.colliders.insert_with_parent(c, body, &mut self.world.bodies);
        self.dirty = true;
        Body { body, collider, kind: BodyKind::Character }
    }

    /// A dynamic body (debris, a ragdoll piece) moving at `linvel`/`angvel`. Reports contacts (`contacts`).
    #[allow(clippy::too_many_arguments)]
    pub fn add_dynamic(&mut self, e: Entity, shape: Shape, pos: Vec3, rot: Quat, linvel: Vec3, angvel: Vec3, group: u32, density: f32) -> Body {
        let rb = RigidBodyBuilder::dynamic().pose(Pose::from_parts(pos, rot)).linvel(linvel).angvel(angvel).ccd_enabled(linvel.length() > 20.0).user_data(entity_bits(e)).build();
        let body = self.world.bodies.insert(rb);
        self.fresh.push(body);
        let c = ColliderBuilder::new(shape.shared()).density(density.max(0.01)).collision_groups(igroups(group, groups::filter_of(group))).active_events(ActiveEvents::COLLISION_EVENTS).user_data(entity_bits(e)).build();
        let collider = self.world.colliders.insert_with_parent(c, body, &mut self.world.bodies);
        self.dirty = true;
        Body { body, collider, kind: BodyKind::Dynamic }
    }

    /// A kinematic body a system places every step (a door, a moving platform, a shield).
    pub fn add_kinematic(&mut self, e: Entity, shape: Shape, pos: Vec3, rot: Quat, group: u32) -> Body {
        let rb = RigidBodyBuilder::kinematic_position_based().pose(Pose::from_parts(pos, rot)).user_data(entity_bits(e)).build();
        let body = self.world.bodies.insert(rb);
        self.fresh.push(body);
        let c = ColliderBuilder::new(shape.shared()).collision_groups(igroups(group, groups::filter_of(group))).user_data(entity_bits(e)).build();
        let collider = self.world.colliders.insert_with_parent(c, body, &mut self.world.bodies);
        self.dirty = true;
        Body { body, collider, kind: BodyKind::Kinematic }
    }

    /// Remove a body and its colliders.
    pub fn remove(&mut self, b: &Body) {
        self.world.remove_body_with_colliders(b.body, true);
        self.dirty = true;
    }

    /// Put a body somewhere now (a teleport, a respawn): queries see it at once, nothing is swept on the way.
    pub fn place(&mut self, b: &Body, pos: Vec3, rot: Quat) {
        if let Some(rb) = self.world.bodies.get_mut(b.body) {
            let p = Pose::from_parts(pos, rot);
            // a kinematic body is never woken here: rapier 0.36's island manager panics ("has no island") on the next
            // step when one is (found by net.rs's reconciliation test, 2026-10-10)
            rb.set_position(p, !rb.is_kinematic());
            if rb.is_kinematic() {
                rb.set_next_kinematic_position(p);
            }
            if rb.is_dynamic() {
                rb.set_linvel(Vec3::ZERO, true);
            }
        }
        self.dirty = true;
    }

    /// Where a kinematic body goes in the next physics step.
    pub fn set_kinematic(&mut self, b: &Body, pos: Vec3, rot: Quat) {
        if let Some(rb) = self.world.bodies.get_mut(b.body) {
            rb.set_next_kinematic_position(Pose::from_parts(pos, rot));
        }
    }

    /// Put a kinematic body where it now is, without a velocity: rapier's character controller lets every kinematic
    /// body it touches carry it along as a moving platform would (pushed by one that walks into it, pulled after one
    /// that backs away), which is right for a lift and wrong for a crowd: an enemy stepping back from its lunge drew
    /// the player after it. Members of a crowd and a joiner's copies of them are placed this way (wave 3), so a
    /// player is stopped by a body and never moved by one; knocks are the feel's own shoves. The next step shows
    /// it to queries, as with `set_kinematic`.
    pub fn set_still(&mut self, b: &Body, pos: Vec3, rot: Quat) {
        if let Some(rb) = self.world.bodies.get_mut(b.body) {
            let p = Pose::from_parts(pos, rot);
            rb.set_position(p, false);
            rb.set_next_kinematic_position(p);
        }
    }

    /// Push a dynamic body (an explosion, a kill's blow), at `point` or its centre.
    pub fn impulse(&mut self, b: &Body, impulse: Vec3, point: Option<Vec3>) {
        if let Some(rb) = self.world.bodies.get_mut(b.body) {
            match point {
                Some(p) => rb.apply_impulse_at_point(impulse, p, true),
                None => rb.apply_impulse(impulse, true),
            }
        }
    }

    /// A body's pose and velocities: (position, rotation, linear, angular).
    pub fn state(&self, b: &Body) -> Option<(Vec3, Quat, Vec3, Vec3)> {
        self.world.bodies.get(b.body).map(|rb| (rb.translation(), *rb.rotation(), rb.linvel(), rb.angvel()))
    }

    /// The entity a collider belongs to (None: the world, or unknown).
    pub fn entity_of(&self, c: ColliderHandle) -> Option<Entity> {
        self.world.colliders.get(c).and_then(|c| entity_of_bits(c.user_data))
    }

    // ---- stepping ----

    /// Make colliders added or moved since the last step visible to queries (the core runs it before each step's
    /// systems; call it after adding colliders mid-step if a query in the same step must see them).
    pub fn refresh(&mut self) {
        if self.dirty {
            self.world.detect_collisions(&(), &());
            self.dirty = false;
        }
    }

    /// One physics step (`STEP` seconds): dynamic bodies move, kinematic ones reach their next pose, contacts gathered.
    pub fn step(&mut self) {
        for h in std::mem::take(&mut self.fresh) {
            let _ = self.world.bodies.get_mut(h);
        }
        self.world.step_with_events(&(), &self.collector);
        self.dirty = false;
        self.contacts.clear();
        if let Ok(mut v) = self.collector.started.lock() {
            self.contacts.append(&mut v);
        }
    }

    // ---- the character controller ----

    /// Move a character from `feet` by `desired` (this step's travel, m) through everything in `mover.blocks`, sliding
    /// along walls, stepping up to `step_height`, holding slopes up to `slope_max`, and, when `snap` is true, held down
    /// onto ground that falls away by up to `mover.snap`. The body itself is not moved: the caller places it
    /// (`set_kinematic` or `place`).
    pub fn move_character(&self, b: &Body, mover: &Mover, feet: Vec3, desired: Vec3, dt: f32, snap: bool) -> CharacterMove {
        let Some(collider) = self.world.colliders.get(b.collider) else {
            return CharacterMove { translation: desired, grounded: false, sliding: false, ceiling: false, wall: Vec3::ZERO, ground_normal: Vec3::Y };
        };
        let kcc = KinematicCharacterController {
            up: Vec3::Y,
            offset: CharacterLength::Absolute(0.01),
            slide: true,
            autostep: (mover.step_height > 0.0).then_some(CharacterAutostep { max_height: CharacterLength::Absolute(mover.step_height), min_width: CharacterLength::Absolute(mover.radius * 0.5), include_dynamic_bodies: false }),
            max_slope_climb_angle: mover.slope_max,
            min_slope_slide_angle: mover.slope_max,
            snap_to_ground: (snap && mover.snap > 0.0).then_some(CharacterLength::Absolute(mover.snap)),
            normal_nudge_factor: 1.0e-4,
        };
        let filter = QueryFilter::new().groups(igroups(groups::ALL, mover.blocks)).exclude_rigid_body(b.body).exclude_sensors();
        let qp = self.world.query_pipeline_with_filter(filter);
        let pose = Pose::from_translation(mover.center(feet));
        let (mut ceiling, mut wall, mut ground_normal) = (false, Vec3::ZERO, Vec3::Y);
        let mut steepest = 1.0f32;
        let r = kcc.move_shape(dt, &qp, collider.shape(), &pose, desired, |c| {
            // the hit surface's normal (world space, out of the obstacle, toward the character)
            let n = c.hit.normal1;
            if n.y < -0.5 {
                ceiling = true;
            } else if n.y < (mover.slope_max).cos() - 1e-3 {
                if n.y < steepest {
                    steepest = n.y;
                    wall = n;
                }
            } else {
                ground_normal = n;
            }
        });
        CharacterMove { translation: r.translation, grounded: r.grounded, sliding: r.is_sliding_down_slope, ceiling, wall, ground_normal }
    }

    /// Sweep an upright capsule (the straight part's `half_height`, `radius`, its centre at `center`) along `dir` (a
    /// unit vector) for up to `max` metres through the static world alone: how far it gets before something is
    /// `skin` away, and that surface's normal (out of it, toward the capsule). Something it already touches stops
    /// it only when it moves into it. The crowd's mover (crowd.rs); nothing is allocated.
    pub fn sweep_world(&self, half_height: f32, radius: f32, center: Vec3, dir: Vec3, max: f32, skin: f32) -> Option<(f32, Vec3)> {
        let capsule = rapier3d::parry::shape::Capsule::new_y(half_height.max(0.0), radius.max(0.001));
        let filter = QueryFilter::new().groups(igroups(groups::ALL, groups::WORLD)).exclude_sensors();
        let opts = ShapeCastOptions { max_time_of_impact: max, target_distance: skin, stop_at_penetration: false, compute_impact_geometry_on_penetration: true };
        let (_, hit) = self.world.query_pipeline_with_filter(filter).cast_shape(&Pose::from_translation(center), dir, &capsule, opts)?;
        Some((hit.time_of_impact, hit.normal1))
    }

    // ---- queries ----

    fn filter(&self, m: &QueryMask) -> QueryFilter<'_> {
        let mut f = QueryFilter::new().groups(igroups(groups::ALL, m.hits));
        if !m.sensors {
            f = f.exclude_sensors();
        }
        if let Some(h) = m.exclude_body {
            f = f.exclude_rigid_body(h);
        } else if let Some(e) = m.exclude {
            // every collider of that entity: its body's, when it has one
            let bits = entity_bits(e);
            if let Some((h, _)) = self.world.bodies.iter().find(|(_, rb)| rb.user_data == bits) {
                f = f.exclude_rigid_body(h);
            }
        }
        f
    }

    /// The first collider a ray from `origin` along `dir` (normalised here) hits within `max` metres.
    pub fn cast_ray(&self, origin: Vec3, dir: Vec3, max: f32, m: QueryMask) -> Option<RayHit> {
        let d = dir.normalize_or_zero();
        if d == Vec3::ZERO {
            return None;
        }
        let ray = Ray::new(origin, d);
        let (h, hit) = self.world.query_pipeline_with_filter(self.filter(&m)).cast_ray_and_get_normal(&ray, max, true)?;
        Some(self.ray_hit(h, origin + d * hit.time_of_impact, hit.normal, hit.time_of_impact))
    }

    /// Every collider a ray passes through within `max` metres, nearest first.
    pub fn cast_ray_all(&self, origin: Vec3, dir: Vec3, max: f32, m: QueryMask) -> Vec<RayHit> {
        let d = dir.normalize_or_zero();
        if d == Vec3::ZERO {
            return Vec::new();
        }
        let ray = Ray::new(origin, d);
        let mut out: Vec<RayHit> = self.world.query_pipeline_with_filter(self.filter(&m)).intersect_ray(ray, max, true).map(|(h, _, hit)| self.ray_hit(h, origin + d * hit.time_of_impact, hit.normal, hit.time_of_impact)).collect();
        out.sort_by(|a, b| a.dist.total_cmp(&b.dist));
        out
    }

    /// Sweep a shape from `origin` along `dir` up to `max` metres: the first collider it would touch.
    pub fn cast_shape(&self, shape: Shape, origin: Vec3, rot: Quat, dir: Vec3, max: f32, m: QueryMask) -> Option<RayHit> {
        let d = dir.normalize_or_zero();
        if d == Vec3::ZERO {
            return None;
        }
        let s = shape.shared();
        let opts = ShapeCastOptions { max_time_of_impact: max, target_distance: 0.0, stop_at_penetration: true, compute_impact_geometry_on_penetration: true };
        let (h, hit) = self.world.query_pipeline_with_filter(self.filter(&m)).cast_shape(&Pose::from_parts(origin, rot), d, s.as_ref(), opts)?;
        Some(self.ray_hit(h, hit.witness1, hit.normal1, hit.time_of_impact))
    }

    /// Every entity whose collider overlaps a ball (`f` per collider; the world's colliders give None).
    pub fn overlap_ball(&self, center: Vec3, radius: f32, m: QueryMask, mut f: impl FnMut(Option<Entity>, ColliderHandle)) {
        let ball = SharedShape::ball(radius.max(0.001));
        for (h, c) in self.world.query_pipeline_with_filter(self.filter(&m)).intersect_shape(Pose::from_translation(center), ball.as_ref()) {
            f(entity_of_bits(c.user_data), h);
        }
    }

    fn ray_hit(&self, h: ColliderHandle, point: Vec3, normal: Vec3, dist: f32) -> RayHit {
        let c = self.world.colliders.get(h);
        RayHit { entity: c.and_then(|c| entity_of_bits(c.user_data)), collider: h, dist, point, normal, groups: c.map(|c| c.collision_groups().memberships.bits()).unwrap_or(0) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> Physics {
        let mut p = Physics::new();
        p.add_box(Vec3::new(-10.0, -0.5, -10.0), Vec3::new(10.0, 0.0, 10.0));
        p.add_box(Vec3::new(5.0, 0.0, -10.0), Vec3::new(6.0, 3.0, 10.0));
        p
    }

    #[test]
    fn a_ray_hits_the_floor_and_names_the_world() {
        let mut p = room();
        p.refresh();
        let h = p.cast_ray(Vec3::new(0.0, 2.0, 0.0), Vec3::NEG_Y, 10.0, QueryMask::new(groups::WORLD)).unwrap();
        assert!((h.dist - 2.0).abs() < 1e-3 && h.entity.is_none() && h.groups == groups::WORLD, "{h:?}");
        assert!((h.normal - Vec3::Y).length() < 1e-3);
        assert!(p.cast_ray(Vec3::new(0.0, 2.0, 0.0), Vec3::NEG_Y, 10.0, QueryMask::new(groups::ENEMY)).is_none(), "a mask without WORLD passes through");
        assert_eq!(p.cast_ray_all(Vec3::new(-8.0, 1.0, 0.0), Vec3::X, 20.0, QueryMask::new(groups::ALL)).len(), 1);
    }

    #[test]
    fn a_character_walks_up_a_step_and_is_stopped_by_a_wall() {
        let mut p = room();
        // a 0.33 m step: higher than the capsule's radius, so only the autostep gets it up (rolling over the edge can't)
        p.add_box(Vec3::new(1.0, 0.0, -2.0), Vec3::new(2.0, 0.33, 2.0));
        let mut w = hecs::World::new();
        let e = w.spawn(());
        let mover = Mover::new(0.3, 0.6);
        let b = p.add_character(e, Vec3::new(0.0, 0.02, 0.0), &mover, groups::PLAYER);
        p.refresh();
        let mut feet = Vec3::new(0.0, 0.02, 0.0);
        let mut max_y: f32 = 0.0;
        for _ in 0..240 {
            // walking at 4 m/s with a grounded step's gravity (21.6 m/s² over one 120 Hz step, averaged)
            let r = p.move_character(&b, &mover, feet, Vec3::new(4.0 / 120.0, -0.00075, 0.0), 1.0 / 120.0, true);
            feet += r.translation;
            max_y = max_y.max(feet.y);
            p.set_kinematic(&b, mover.center(feet), Quat::IDENTITY);
            p.step();
        }
        assert!(max_y > 0.3, "stepped up onto the 0.33 m box (rose to {max_y})");
        assert!(feet.x < 5.0 - 0.3 + 0.02 && feet.x > 4.5, "stopped by the wall at x 5 (x {})", feet.x);
    }

    /// Feel target 8/11: a kill bursts into about 50 physics pieces, and spawning them "must not stall a frame; budget
    /// under 2 ms". Native timing (`cargo test --release -p forge-core -- --ignored --nocapture debris_burst`).
    #[test]
    #[ignore]
    fn debris_burst_timing() {
        let mut p = room();
        let mut w = hecs::World::new();
        for i in 0..20 {
            let e = w.spawn(());
            p.add_character(e, Vec3::new((i % 5) as f32 * 1.2 - 3.0, 0.0, -(i / 5) as f32 * 1.2 - 2.0), &Mover::new(0.35, 0.55), groups::ENEMY);
        }
        p.refresh();
        let t0 = std::time::Instant::now();
        for i in 0..50 {
            let e = w.spawn(());
            let a = i as f32 * 0.7;
            p.add_dynamic(e, Shape::Cuboid(Vec3::new(0.05, 0.08, 0.05)), Vec3::new(a.sin() * 0.3, 1.0 + (i % 7) as f32 * 0.1, -3.0 + a.cos() * 0.3), Quat::IDENTITY, Vec3::new(a.sin() * 6.0, 4.0, a.cos() * 6.0), Vec3::new(3.0, 1.0, 2.0), groups::DEBRIS, 400.0);
        }
        let spawn = t0.elapsed();
        let mut worst = std::time::Duration::ZERO;
        let t1 = std::time::Instant::now();
        for _ in 0..240 {
            let s = std::time::Instant::now();
            p.step();
            worst = worst.max(s.elapsed());
        }
        eprintln!("50 pieces among 20 enemies: spawn {:?}, 240 steps {:?} (mean {:?}, worst {:?})", spawn, t1.elapsed(), t1.elapsed() / 240, worst);
    }

    #[test]
    fn debris_falls_and_reports_its_contact_with_an_entity() {
        let mut p = room();
        let mut w = hecs::World::new();
        let (a, target) = (w.spawn(()), w.spawn(()));
        let mover = Mover::new(0.3, 0.6);
        let _t = p.add_character(target, Vec3::new(0.0, 0.0, 0.0), &mover, groups::ENEMY);
        let d = p.add_dynamic(a, Shape::Ball(0.1), Vec3::new(0.0, 3.0, 0.0), Quat::IDENTITY, Vec3::ZERO, Vec3::ZERO, groups::DEBRIS, 1.0);
        let mut saw = None;
        for _ in 0..240 {
            p.step();
            for c in &p.contacts {
                if c.a == Some(target) || c.b == Some(target) {
                    saw.get_or_insert(*c);
                }
            }
        }
        let c = saw.expect("the falling piece touched the enemy's capsule");
        assert!(c.speed > 1.0 && (c.groups_a | c.groups_b) & groups::DEBRIS != 0, "{c:?}");
        let (pos, ..) = p.state(&d).unwrap();
        assert!(pos.y < 3.0);
        p.remove(&d);
        assert!(p.state(&d).is_none());
    }
}
