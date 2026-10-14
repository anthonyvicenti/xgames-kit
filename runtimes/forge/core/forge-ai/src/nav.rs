//! Navigation for crowds, cheap enough for phones: one walkable grid over the arena (cells of `cell` metres, blocked
//! where the static world stands at body height), and a flow field per target (every cell's walking distance to the
//! target, 8-neighbour, Dial's algorithm over integer costs 10/14). An enemy reads the field under its feet and steps
//! toward the neighbour nearest the target; with a clear line on the grid it walks straight.
//!
//! - The grid is built once per static world (`Grid::build`, rebuilt when the physics world's static colliders change)
//!   from ball overlaps against the WORLD group at chest height, so it needs nothing but the colliders the world gave.
//! - A field is rebuilt when its target moves to another cell, at most every `FIELD_EVERY` steps (≈ 33 µs for a
//!   30 m arena at 0.5 m natively).
//! - Line of sight on the grid (`Grid::los`) is a cell walk, not a physics query.
use std::collections::HashMap;

use forge_core::glam::{Vec2, Vec3};
use forge_core::hecs::Entity;
use forge_core::physics::{groups, Physics, QueryMask};

/// Cell costs: straight 10, diagonal 14.
const STRAIGHT: u16 = 10;
const DIAGONAL: u16 = 14;
pub const UNREACHED: u16 = u16::MAX;
/// A field is rebuilt at most this often (steps), when its target changed cell.
pub const FIELD_EVERY: u64 = 6;

#[derive(Clone, Debug)]
pub struct Grid {
    pub min: Vec2,
    pub cell: f32,
    pub w: usize,
    pub h: usize,
    pub blocked: Vec<bool>,
    /// The static colliders the physics world had when it was built (a change rebuilds it).
    pub statics: usize,
}

const N8: [(i32, i32, u16); 8] = [(1, 0, STRAIGHT), (-1, 0, STRAIGHT), (0, 1, STRAIGHT), (0, -1, STRAIGHT), (1, 1, DIAGONAL), (1, -1, DIAGONAL), (-1, 1, DIAGONAL), (-1, -1, DIAGONAL)];

impl Grid {
    /// Cells over `min`..`max` (x, z), blocked where a ball of `clearance` at 0.9 m (chest height of a 1.8 m body)
    /// touches the static world.
    pub fn build(physics: &Physics, min: Vec2, max: Vec2, cell: f32, clearance: f32) -> Grid {
        let cell = cell.clamp(0.2, 4.0);
        let w = (((max.x - min.x) / cell).ceil() as usize).clamp(1, 512);
        let h = (((max.y - min.y) / cell).ceil() as usize).clamp(1, 512);
        let mut blocked = vec![false; w * h];
        let mask = QueryMask::new(groups::WORLD);
        for z in 0..h {
            for x in 0..w {
                let c = min + Vec2::new((x as f32 + 0.5) * cell, (z as f32 + 0.5) * cell);
                let mut hit = false;
                physics.overlap_ball(Vec3::new(c.x, 0.9, c.y), clearance, mask, |_, _| hit = true);
                blocked[z * w + x] = hit;
            }
        }
        Grid { min, cell, w, h, blocked, statics: physics.static_count() }
    }

    /// An open grid (tests; a world with no colliders).
    pub fn open(min: Vec2, max: Vec2, cell: f32) -> Grid {
        let w = (((max.x - min.x) / cell).ceil() as usize).clamp(1, 512);
        let h = (((max.y - min.y) / cell).ceil() as usize).clamp(1, 512);
        Grid { min, cell, w, h, blocked: vec![false; w * h], statics: 0 }
    }

    pub fn len(&self) -> usize {
        self.w * self.h
    }
    pub fn is_empty(&self) -> bool {
        self.blocked.is_empty()
    }
    pub fn cell_of(&self, p: Vec2) -> Option<usize> {
        let q = (p - self.min) / self.cell;
        if q.x < 0.0 || q.y < 0.0 {
            return None;
        }
        let (x, z) = (q.x as usize, q.y as usize);
        (x < self.w && z < self.h).then_some(z * self.w + x)
    }
    /// The cell under `p`, clamped onto the grid.
    pub fn cell_clamped(&self, p: Vec2) -> usize {
        let q = (p - self.min) / self.cell;
        let x = (q.x.max(0.0) as usize).min(self.w - 1);
        let z = (q.y.max(0.0) as usize).min(self.h - 1);
        z * self.w + x
    }
    pub fn center(&self, i: usize) -> Vec2 {
        self.min + Vec2::new(((i % self.w) as f32 + 0.5) * self.cell, ((i / self.w) as f32 + 0.5) * self.cell)
    }
    pub fn free(&self, i: usize) -> bool {
        !self.blocked.get(i).copied().unwrap_or(true)
    }
    pub fn free_at(&self, p: Vec2) -> bool {
        self.cell_of(p).is_some_and(|i| self.free(i))
    }
    /// The nearest free cell to `p` within `rings` cells (itself first).
    pub fn nearest_free(&self, p: Vec2, rings: i32) -> Option<usize> {
        let c = self.cell_clamped(p);
        if self.free(c) {
            return Some(c);
        }
        let (cx, cz) = ((c % self.w) as i32, (c / self.w) as i32);
        let mut best: Option<(f32, usize)> = None;
        for r in 1..=rings {
            for dz in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dz.abs() != r {
                        continue;
                    }
                    let (x, z) = (cx + dx, cz + dz);
                    if x < 0 || z < 0 || x >= self.w as i32 || z >= self.h as i32 {
                        continue;
                    }
                    let i = z as usize * self.w + x as usize;
                    if self.free(i) {
                        let d = self.center(i).distance_squared(p);
                        if best.is_none_or(|b| d < b.0) {
                            best = Some((d, i));
                        }
                    }
                }
            }
            if best.is_some() {
                break;
            }
        }
        best.map(|b| b.1)
    }
    /// A clear straight line from `a` to `b` on the grid (every cell it crosses free; points off the grid count as
    /// clear only when both ends are off it).
    pub fn los(&self, a: Vec2, b: Vec2) -> bool {
        let d = b - a;
        let len = d.length();
        let n = ((len / (self.cell * 0.5)).ceil() as usize).max(1);
        for k in 1..n {
            let p = a + d * (k as f32 / n as f32);
            if let Some(i) = self.cell_of(p)
                && self.blocked[i] {
                    return false;
                }
        }
        true
    }
    /// The share of cells that are free.
    pub fn free_share(&self) -> f32 {
        if self.blocked.is_empty() {
            return 0.0;
        }
        self.blocked.iter().filter(|b| !**b).count() as f32 / self.blocked.len() as f32
    }
}

/// Every cell's walking distance to one target cell (in tenths of a cell; UNREACHED where no way leads).
#[derive(Clone, Debug, Default)]
pub struct Field {
    pub goal: usize,
    pub dist: Vec<u16>,
    pub built: u64,
    /// The grid version it was built on (`Nav::version`).
    pub version: u32,
}

impl Field {
    /// Dial's algorithm (a bucket queue: costs are 10 and 14, so 15 buckets in a ring hold every open distance).
    pub fn build(grid: &Grid, goal: usize, step: u64, scratch: &mut [Vec<u32>; 15]) -> Field {
        let mut dist = vec![UNREACHED; grid.len()];
        let goal = if grid.free(goal) { goal } else { grid.nearest_free(grid.center(goal), 6).unwrap_or(goal) };
        if goal >= dist.len() {
            return Field { goal, dist, built: step, version: 0 };
        }
        for b in scratch.iter_mut() {
            b.clear();
        }
        dist[goal] = 0;
        scratch[0].push(goal as u32);
        let mut open = 1usize;
        let mut cur: u32 = 0;
        let (w, h) = (grid.w as i32, grid.h as i32);
        while open > 0 {
            let slot = (cur % 15) as usize;
            let mut list = std::mem::take(&mut scratch[slot]);
            for &i in &list {
                open -= 1;
                let i = i as usize;
                if dist[i] as u32 != cur {
                    continue;
                }
                let (x, z) = ((i % grid.w) as i32, (i / grid.w) as i32);
                for (dx, dz, cost) in N8 {
                    let (nx, nz) = (x + dx, z + dz);
                    if nx < 0 || nz < 0 || nx >= w || nz >= h {
                        continue;
                    }
                    let n = nz as usize * grid.w + nx as usize;
                    if grid.blocked[n] {
                        continue;
                    }
                    // no cutting a blocked corner
                    if dx != 0 && dz != 0 && (grid.blocked[z as usize * grid.w + nx as usize] || grid.blocked[nz as usize * grid.w + x as usize]) {
                        continue;
                    }
                    let nd = cur + cost as u32;
                    if nd < dist[n] as u32 && nd < UNREACHED as u32 {
                        dist[n] = nd as u16;
                        scratch[(nd % 15) as usize].push(n as u32);
                        open += 1;
                    }
                }
            }
            list.clear();
            scratch[slot] = list;
            cur += 1;
        }
        Field { goal, dist, built: step, version: 0 }
    }

    /// The way to walk from `p`: toward the neighbouring cell nearest the goal (None off the grid, at the goal, or
    /// where no way leads).
    pub fn dir(&self, grid: &Grid, p: Vec2) -> Option<Vec2> {
        let here = match grid.cell_of(p) {
            Some(i) if self.dist.get(i).is_some_and(|d| *d != UNREACHED) => i,
            // standing in a blocked or unreached cell (pushed against a wall): the nearest free one first
            _ => {
                let i = grid.nearest_free(p, 3)?;
                return Some((grid.center(i) - p).normalize_or_zero()).filter(|d| *d != Vec2::ZERO);
            }
        };
        if self.dist[here] == 0 {
            return None;
        }
        let (x, z) = ((here % grid.w) as i32, (here / grid.w) as i32);
        let mut best = (self.dist[here], here);
        for (dx, dz, _) in N8 {
            let (nx, nz) = (x + dx, z + dz);
            if nx < 0 || nz < 0 || nx >= grid.w as i32 || nz >= grid.h as i32 {
                continue;
            }
            let n = nz as usize * grid.w + nx as usize;
            if dx != 0 && dz != 0 && (grid.blocked[z as usize * grid.w + nx as usize] || grid.blocked[nz as usize * grid.w + x as usize]) {
                continue;
            }
            if self.dist[n] < best.0 {
                best = (self.dist[n], n);
            }
        }
        if best.1 == here {
            return None;
        }
        Some((grid.center(best.1) - p).normalize_or_zero()).filter(|d| *d != Vec2::ZERO)
    }

    /// The walking distance from `p` to the goal, metres (None where no way leads).
    pub fn distance(&self, grid: &Grid, p: Vec2) -> Option<f32> {
        let i = grid.cell_of(p)?;
        let d = *self.dist.get(i)?;
        (d != UNREACHED).then(|| d as f32 / STRAIGHT as f32 * grid.cell)
    }

    /// The next waypoint from `from` toward this field's goal, walking the field downhill from `from`'s cell: the
    /// farthest cell along the way still in a straight grid line of `from` (a smoothed path, at most `look` cells on).
    pub fn waypoint(&self, grid: &Grid, from: Vec2, look: usize) -> Option<Vec2> {
        let mut i = grid.cell_of(from)?;
        if self.dist.get(i).is_none_or(|d| *d == UNREACHED) {
            i = grid.nearest_free(from, 3)?;
        }
        let mut best = None;
        for _ in 0..look {
            let (x, z) = ((i % grid.w) as i32, (i / grid.w) as i32);
            let mut next = (self.dist[i], i);
            for (dx, dz, _) in N8 {
                let (nx, nz) = (x + dx, z + dz);
                if nx < 0 || nz < 0 || nx >= grid.w as i32 || nz >= grid.h as i32 {
                    continue;
                }
                let n = nz as usize * grid.w + nx as usize;
                if self.dist[n] < next.0 {
                    next = (self.dist[n], n);
                }
            }
            if next.1 == i {
                break;
            }
            i = next.1;
            if grid.los(from, grid.center(i)) {
                best = Some(grid.center(i));
            } else {
                break;
            }
        }
        best
    }
}

/// The AI's navigation: the grid, where it should cover, and a flow field per target entity (players, bots, goals).
#[derive(Default)]
pub struct Nav {
    pub grid: Option<Grid>,
    /// The arena's bounds and cell size (OP_ARENA); None: a 64 m square around the origin at 0.5 m.
    pub bounds: Option<(Vec2, Vec2, f32)>,
    pub fields: HashMap<Entity, Field>,
    /// Fields toward fixed points (a bot's goal), by goal cell.
    pub goals: HashMap<usize, Field>,
    pub builds: u32,
    pub field_builds: u32,
    /// Bumped when the grid learns an obstacle (fields made before it are rebuilt).
    pub version: u32,
    /// Cells learned blocked (QA).
    pub learned: u32,
    scratch: [Vec<u32>; 15],
}

/// Clearance a body needs from the static world (most enemies are 0.35-0.6 m wide; the grid is coarse anyway).
pub const CLEARANCE: f32 = 0.32;

impl Nav {
    /// The grid, built or rebuilt when the static world changed.
    pub fn ensure(&mut self, physics: &Physics) {
        let statics = physics.static_count();
        if self.grid.as_ref().is_some_and(|g| g.statics == statics) {
            return;
        }
        let (min, max, cell) = self.bounds.unwrap_or((Vec2::splat(-32.0), Vec2::splat(32.0), 0.5));
        self.grid = Some(Grid::build(physics, min, max, cell, CLEARANCE));
        self.fields.clear();
        self.goals.clear();
        self.builds += 1;
    }
    /// Set the arena (OP_ARENA): the grid is rebuilt on the next step.
    pub fn set_bounds(&mut self, min: Vec2, max: Vec2, cell: f32) {
        self.bounds = Some((min.min(max), min.max(max), cell));
        self.grid = None;
    }
    /// Keep `target`'s field current: rebuilt when it moved to another cell, at most every FIELD_EVERY steps.
    pub fn track(&mut self, target: Entity, at: Vec2, step: u64) {
        let Some(grid) = self.grid.as_ref() else { return };
        let cell = grid.cell_clamped(at);
        let stale = match self.fields.get(&target) {
            None => true,
            Some(f) => (f.goal != cell && step >= f.built + FIELD_EVERY && grid.free(cell)) || f.version != self.version,
        };
        if stale {
            let mut f = Field::build(grid, cell, step, &mut self.scratch);
            f.version = self.version;
            self.fields.insert(target, f);
            self.field_builds += 1;
        }
    }
    /// The next waypoint from `from` toward a fixed point `to` (a field toward it, cached by its cell; at most 8 kept).
    pub fn waypoint_to(&mut self, from: Vec2, to: Vec2, step: u64, look: usize) -> Option<Vec2> {
        let grid = self.grid.as_ref()?;
        let cell = grid.nearest_free(to, 4)?;
        if !self.goals.contains_key(&cell) {
            if self.goals.len() >= 8 {
                let oldest = self.goals.iter().min_by_key(|(_, f)| f.built).map(|(k, _)| *k);
                if let Some(k) = oldest {
                    self.goals.remove(&k);
                }
            }
            let f = Field::build(grid, cell, step, &mut self.scratch);
            self.goals.insert(cell, f);
            self.field_builds += 1;
        }
        self.goals.get(&cell)?.waypoint(grid, from, look)
    }

    /// Mark the cell at `p` blocked: something in the static world the chest-height test missed (a low ledge). The
    /// fields are rebuilt; the grid forgets it when the static world changes.
    pub fn learn(&mut self, p: Vec2) {
        let Some(grid) = self.grid.as_mut() else { return };
        let Some(i) = grid.cell_of(p) else { return };
        if !grid.blocked[i] {
            grid.blocked[i] = true;
            self.learned += 1;
            self.version += 1;
            self.goals.clear();
        }
    }

    /// Forget fields whose target is gone.
    pub fn retain(&mut self, alive: impl Fn(Entity) -> bool) {
        self.fields.retain(|e, _| alive(*e));
    }
    /// Which way to walk from `from` to reach `to` (the field of `target` when it has one; straight with a clear line).
    pub fn steer(&self, from: Vec2, to: Vec2, target: Option<Entity>) -> Vec2 {
        let direct = (to - from).normalize_or_zero();
        let Some(grid) = self.grid.as_ref() else { return direct };
        if grid.los(from, to) {
            return direct;
        }
        match target.and_then(|t| self.fields.get(&t)).and_then(|f| f.dir(grid, from)) {
            Some(d) => d,
            None => direct,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wall_grid() -> Grid {
        // 20 × 20 m at 0.5 m, a wall along z = 0 from x = −6 to 6
        let mut g = Grid::open(Vec2::splat(-10.0), Vec2::splat(10.0), 0.5);
        for i in 0..g.len() {
            let c = g.center(i);
            if c.y.abs() < 0.5 && c.x.abs() < 6.0 {
                g.blocked[i] = true;
            }
        }
        g
    }

    #[test]
    fn a_field_routes_around_a_wall_and_the_grid_sees_it() {
        let g = wall_grid();
        let goal = g.cell_of(Vec2::new(0.0, -5.0)).unwrap();
        let f = Field::build(&g, goal, 0, &mut Default::default());
        let from = Vec2::new(0.0, 5.0);
        assert!(!g.los(from, Vec2::new(0.0, -5.0)), "the wall blocks the line");
        assert!(g.los(Vec2::new(8.0, 5.0), Vec2::new(8.0, -5.0)), "past its end the line is clear");
        // walking the field from behind the wall reaches the goal by going round an end
        let mut p = from;
        let mut widest: f32 = 0.0;
        for _ in 0..400 {
            let Some(d) = f.dir(&g, p) else { break };
            p += d * 0.1;
            widest = widest.max(p.x.abs());
            assert!(g.free_at(p) || g.cell_of(p).is_none(), "it walked into the wall at {p}");
        }
        assert!(p.distance(Vec2::new(0.0, -5.0)) < 0.6, "it arrived ({p})");
        assert!(widest > 5.9, "round the end of the wall ({widest})");
        let d = f.distance(&g, from).unwrap();
        assert!(d > 16.0 && d < 22.0, "the way round is longer than 10 m ({d})");
        assert!(f.waypoint(&g, from, 40).is_some());
    }

    #[test]
    fn a_field_for_a_30_m_arena_is_cheap() {
        let g = Grid::open(Vec2::splat(-15.0), Vec2::splat(15.0), 0.5);
        let mut s = Default::default();
        let t = std::time::Instant::now();
        for k in 0..50 {
            let f = Field::build(&g, (k * 37) % g.len(), 0, &mut s);
            assert_eq!(f.dist.iter().filter(|d| **d == UNREACHED).count(), 0);
        }
        let each = t.elapsed() / 50;
        eprintln!("a 60 × 60 field: {each:?}");
        assert!(each < std::time::Duration::from_millis(5), "{each:?}");
    }
}
