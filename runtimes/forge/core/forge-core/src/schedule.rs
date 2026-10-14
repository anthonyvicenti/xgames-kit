//! The system schedule (ARCHITECTURE.md "Schedule"): every fixed step runs six stages in order, and each stage runs its
//! systems in the order they were added. A system is a named closure over `&mut Sim`. Crates plug in through a
//! `Plugin` (`Core::add_plugin`) that adds, replaces or orders systems by name, never by editing forge-core:
//!
//! | stage | for | the core's own systems |
//! |---|---|---|
//! | `Input` | turning commands and buttons into intent | (none yet) |
//! | `Feel` | the player's controller, weapons, hits (forge-feel) | `core.move` |
//! | `Ai` | enemies, the wave director (forge-ai) | (none) |
//! | `Physics` | the character controller, the rapier step | `core.character`, `core.physics` |
//! | `Post` | what follows from where things are: footsteps, lifetimes, animation, hurtboxes | `core.walk`, `core.lifetime`, `core.replicas`, `core.anim`, `core.hurtboxes` |
//! | `Events` | turning this step's events into more events (a hit → a flash, a sound, a kick) | (none) |
//!
//! Names are `<crate>.<what>` ("feel.weapons", "ai.chasers"). `replace("core.move", …)` is how track F swaps the core's
//! basic walk for its own controller; `add_before`/`add_after` put a system next to another, in that one's stage.
use crate::sim::Sim;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Stage {
    Input = 0,
    Feel = 1,
    Ai = 2,
    Physics = 3,
    Post = 4,
    Events = 5,
}

pub const STAGES: [Stage; 6] = [Stage::Input, Stage::Feel, Stage::Ai, Stage::Physics, Stage::Post, Stage::Events];

impl Stage {
    pub fn name(self) -> &'static str {
        ["input", "feel", "ai", "physics", "post", "events"][self as usize]
    }
}

pub type SystemFn = Box<dyn FnMut(&mut Sim)>;

struct System {
    name: String,
    run: SystemFn,
    enabled: bool,
}

#[derive(Default)]
pub struct Schedule {
    stages: [Vec<System>; 6],
}

impl Schedule {
    fn find(&self, name: &str) -> Option<(usize, usize)> {
        self.stages.iter().enumerate().find_map(|(s, list)| list.iter().position(|x| x.name == name).map(|i| (s, i)))
    }
    pub fn has(&self, name: &str) -> bool {
        self.find(name).is_some()
    }
    /// Add a system at the end of `stage`. → false (and nothing added) when the name is taken.
    pub fn add(&mut self, stage: Stage, name: &str, f: impl FnMut(&mut Sim) + 'static) -> bool {
        if self.has(name) {
            return false;
        }
        self.stages[stage as usize].push(System { name: name.to_string(), run: Box::new(f), enabled: true });
        true
    }
    /// Add a system just before `other`, in `other`'s stage. → false when `other` is missing or the name is taken.
    pub fn add_before(&mut self, other: &str, name: &str, f: impl FnMut(&mut Sim) + 'static) -> bool {
        self.insert_near(other, name, Box::new(f), 0)
    }
    /// Add a system just after `other`, in `other`'s stage.
    pub fn add_after(&mut self, other: &str, name: &str, f: impl FnMut(&mut Sim) + 'static) -> bool {
        self.insert_near(other, name, Box::new(f), 1)
    }
    fn insert_near(&mut self, other: &str, name: &str, run: SystemFn, offset: usize) -> bool {
        if self.has(name) {
            return false;
        }
        let Some((s, i)) = self.find(other) else { return false };
        self.stages[s].insert(i + offset, System { name: name.to_string(), run, enabled: true });
        true
    }
    /// Swap a system's code, keeping its name and place. → false when there is no such system.
    pub fn replace(&mut self, name: &str, f: impl FnMut(&mut Sim) + 'static) -> bool {
        let Some((s, i)) = self.find(name) else { return false };
        self.stages[s][i].run = Box::new(f);
        true
    }
    pub fn remove(&mut self, name: &str) -> bool {
        let Some((s, i)) = self.find(name) else { return false };
        self.stages[s].remove(i);
        true
    }
    /// Turn a system off or on without removing it (a fixture measuring the core's walk alone).
    pub fn set_enabled(&mut self, name: &str, on: bool) -> bool {
        let Some((s, i)) = self.find(name) else { return false };
        self.stages[s][i].enabled = on;
        true
    }
    /// Every system, in the order a step runs them: (stage, name, enabled).
    pub fn list(&self) -> Vec<(Stage, String, bool)> {
        STAGES.iter().flat_map(|&st| self.stages[st as usize].iter().map(move |x| (st, x.name.clone(), x.enabled))).collect()
    }
    pub fn run_stage(&mut self, stage: Stage, sim: &mut Sim) {
        for s in self.stages[stage as usize].iter_mut() {
            if s.enabled {
                (s.run)(sim);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systems_run_by_stage_then_order_and_can_be_moved_swapped_and_removed() {
        let mut s = Schedule::default();
        assert!(s.add(Stage::Post, "b", |sim| sim.time.step += 100));
        assert!(s.add(Stage::Feel, "a", |sim| sim.time.step *= 2));
        assert!(!s.add(Stage::Ai, "a", |_| {}), "a name is taken once");
        assert!(s.add_before("b", "b0", |sim| sim.time.step += 1));
        assert!(s.add_after("a", "a1", |sim| sim.time.step += 3));
        assert!(!s.add_after("nope", "x", |_| {}));
        let order: Vec<String> = s.list().into_iter().map(|x| x.1).collect();
        assert_eq!(order, ["a", "a1", "b0", "b"]);
        let mut sim = Sim::default();
        sim.time.step = 1;
        for st in STAGES {
            s.run_stage(st, &mut sim);
        }
        assert_eq!(sim.time.step, (2 + 3) + 1 + 100);
        assert!(s.replace("a", |sim| sim.time.step = 0));
        assert!(s.set_enabled("b", false));
        assert!(s.remove("a1"));
        for st in STAGES {
            s.run_stage(st, &mut sim);
        }
        assert_eq!(sim.time.step, 1);
    }
}
