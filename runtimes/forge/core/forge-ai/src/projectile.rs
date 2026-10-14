//! Enemy projectiles: a caster's orb (moment 13: a large glowing orb with its own light, about 10 m in 0.4 s). Each is
//! an entity of kind PROJECTILE (its type is the caster's row) that the entities view carries, so the renderer draws
//! it and its light (colour, radius and intensity in the AI view). It moves on a swept ball against the world and the
//! players; a player hit takes the caster's damage; either way it bursts (a light, particles, the impact sound).
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::glam::{Quat, Vec3};
use forge_core::hecs::Entity;
use forge_core::physics::{groups, QueryMask, Shape};
use forge_core::sim::Sim;

/// An orb in flight.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Orb {
    pub owner: u32,
    pub row: u16,
    pub vel: Vec3,
    pub damage: f32,
    pub radius: f32,
    pub life: f32,
    pub color: [f32; 3],
    pub light: f32,
    pub intensity: f32,
    /// Its caster's elite mark (wave 7: a burning caster's orb sets alight).
    pub mark: u8,
}

/// What a caster's release asks for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OrbSpawn {
    pub owner: u32,
    pub row: u16,
    pub from: Vec3,
    pub dir: Vec3,
    pub speed: f32,
    pub damage: f32,
    pub color: [f32; 3],
    pub light: f32,
    pub intensity: f32,
    pub mark: u8,
}

pub const ORB_RADIUS: f32 = 0.18;
pub const ORB_LIFE: f32 = 3.0;

pub fn spawn(sim: &mut Sim, o: OrbSpawn) -> Entity {
    let d = o.dir.normalize_or(Vec3::NEG_Z);
    let yaw = (-d.x).atan2(-d.z);
    let e = sim.spawn_actor(kind::PROJECTILE, o.row, o.from, yaw);
    let orb = Orb { owner: o.owner, row: o.row, vel: d * o.speed, damage: o.damage, radius: ORB_RADIUS, life: ORB_LIFE, color: o.color, light: o.light, intensity: o.intensity, mark: o.mark };
    let _ = sim.world.insert(e, (orb, Team::ENEMIES));
    if let Ok(mut v) = sim.world.get::<&mut Velocity>(e) {
        v.linear = orb.vel;
    }
    e
}

/// The Ai-stage system: every orb one step on.
pub fn system(sim: &mut Sim) {
    let dt = sim.time.dt;
    let list: Vec<(Entity, Orb, Vec3)> = sim.world.query::<(Entity, &Orb, &Transform)>().without::<&Replica>().iter().map(|(e, o, t)| (e, *o, t.pos)).collect();
    if list.is_empty() {
        return;
    }
    let mut bursts: Vec<(Entity, Orb, Vec3, Option<Entity>, Vec3)> = Vec::new();
    let mut moves: Vec<(Entity, Vec3, f32)> = Vec::new();
    for (e, o, pos) in list {
        let life = o.life - dt;
        let step = o.vel * dt;
        let len = step.length();
        let owner = sim.entity_of(o.owner);
        let mut mask = QueryMask::new(groups::WORLD | groups::PLAYER);
        mask.exclude = owner;
        match sim.physics.cast_shape(Shape::Ball(o.radius), pos, Quat::IDENTITY, step, len, mask) {
            Some(hit) => {
                let at = pos + step.normalize_or_zero() * hit.dist;
                let who = hit.entity.filter(|x| sim.world.get::<&Player>(*x).is_ok());
                bursts.push((e, o, at, who, hit.normal));
            }
            None if life <= 0.0 => bursts.push((e, o, pos + step, None, Vec3::Y)),
            None => moves.push((e, pos + step, life)),
        }
    }
    for (e, at, life) in moves {
        if let Ok((t, o)) = sim.world.query_one_mut::<(&mut Transform, &mut Orb)>(e) {
            t.pos = at;
            o.life = life;
        }
    }
    let snd = |sim: &Sim, row: u16| sim.res.get::<crate::defs::Roster>().map(|r| r.def(row).snd_impact.clone()).unwrap_or_else(|| "enemy-orb-impact".to_string());
    for (e, o, at, who, normal) in bursts {
        if let Some(p) = who {
            let dealt = sim.damage(p, o.damage, o.owner, None, o.vel.normalize_or_zero());
            // wave 7: a burning caster's orb sets alight
            if dealt.damage > 0.0 && crate::elite::Mod::from_u8(o.mark) == crate::elite::Mod::Burning && o.mark & crate::elite::CHILD == 0 {
                let (dps, secs) = sim.res.get::<crate::defs::Roster>().map(|r| (r.elites.burn_dps, r.elites.burn_seconds)).unwrap_or((5.0, 3.0));
                crate::elite::ignite(sim, p, o.owner, dps, secs);
            }
        }
        sim.emit(Event::Light(events::Light { source: o.owner, pos: at + normal * 0.2, color: o.color, radius: (o.light * 0.6).max(1.5), intensity: o.intensity * 0.8, frames: 4 }));
        let impact = sim.names.id("orb-burst");
        sim.emit(Event::Particles(events::Particles { name: impact, count: 14, pos: at, dir: normal, speed: 3.0, spread: 1.2 }));
        let name = snd(sim, o.row);
        sim.sound(&name, at, -2.0, o.owner);
        sim.despawn(e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::cmd::Writer;
    use forge_core::Core;

    #[test]
    fn an_orb_flies_hits_the_player_and_bursts() {
        let mut c = Core::new();
        let mut w = Writer::default();
        w.add_box([-50.0, -1.0, -50.0], [50.0, 0.0, 50.0]);
        w.spawn(1, 0.0, 0.05, 0.0, 0.0, true);
        c.cmds[..w.words.len()].copy_from_slice(&w.words);
        c.tick(0.0, w.words.len());
        c.schedule.add(forge_core::schedule::Stage::Ai, "ai.projectiles", system);
        let o = spawn(&mut c.sim, OrbSpawn { owner: 0, row: 0, from: Vec3::new(0.0, 1.2, -10.0), dir: Vec3::Z, speed: 24.0, damage: 13.0, color: [0.1, 1.0, 0.3], light: 4.6, intensity: 6.0, mark: 0 });
        let net = c.sim.net_of(o);
        let mut t = 0.0;
        while c.sim.entity_of(net).is_some() && t < 2.0 {
            c.tick(1.0 / 60.0, 0);
            t += 1.0 / 60.0;
        }
        assert!(t > 0.3 && t < 0.5, "10 m at 24 m/s in about 0.4 s ({t})");
        let p = c.player(1).unwrap();
        let h = c.sim.world.get::<&Health>(p).unwrap();
        assert!(h.hp + h.armor < 120.0, "the player took the hit ({} + {})", h.hp, h.armor);
    }
}
