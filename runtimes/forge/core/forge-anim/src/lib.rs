//! forge-anim (research/gf-forge/core/ARCHITECTURE.md "Animation"): skeletal animation on the CPU, shared by the core
//! (hurtboxes on bones, ragdolls, hit reactions) and the renderer (it uploads the skin matrices; GPU skinning is
//! track R's).
//!
//! - `Library`: bodies (`Body::parse`, a skinned GLB's skeleton) and clip sets (`ClipSet::parse`, a GLB's animations),
//!   each from a slot file's bytes, never compiled in.
//! - `Library::animator(body, set)`: an `Animator` playing the set's clips on the body: through the gf-humanoid-1
//!   retarget (`retarget::Retarget`, rig.js's own math) when the set is a standard clip file, else by bone name.
//! - `Animator::play` (crossfades, an upper-body layer), `impulse` (additive per-bone springs for hit reactions),
//!   `advance(dt)`, `evaluate` into a `PoseBuffer`: one flat array of 4×4 matrices for every animated entity, world
//!   (model space) and skin (world × inverse bind).
//! - `humanoid`: the gf-humanoid-1 bone map (names, parents, required bones, swing sets, the upper mask, sockets and
//!   ragdoll parts).
pub mod animator;
pub mod body;
pub mod clips;
pub mod gltf_io;
pub mod humanoid;
pub mod pose;
pub mod retarget;

use std::collections::HashMap;

pub use glam;
pub use animator::{to_model, Animator, Impulse, Play, Playing};
pub use body::Body;
pub use clips::{Clip, ClipSet, Layer};
pub use pose::{PoseBuffer, Trs};
pub use retarget::Retarget;

/// Every body and clip set loaded, and the retarget of each (body, set) pair in use.
#[derive(Default)]
pub struct Library {
    pub bodies: Vec<Body>,
    pub sets: Vec<ClipSet>,
    retargets: HashMap<(usize, usize), Retarget>,
}

impl Library {
    /// A body from a GLB's bytes (meshopt decoded). → its id.
    pub fn add_body(&mut self, bytes: &[u8]) -> Result<usize, String> {
        self.bodies.push(Body::parse(bytes)?);
        Ok(self.bodies.len() - 1)
    }
    /// A clip set from a GLB's bytes. → its id.
    pub fn add_clips(&mut self, bytes: &[u8]) -> Result<usize, String> {
        self.sets.push(ClipSet::parse(bytes)?);
        Ok(self.sets.len() - 1)
    }
    /// An animator for `body` playing `set`: retargeted when the set is a standard clip file and the body is on
    /// gf-humanoid-1, else by bone name. Err when either is unknown or the retarget refuses the body.
    pub fn animator(&mut self, body: usize, set: usize) -> Result<Animator, String> {
        let b = self.bodies.get(body).ok_or("no such body")?;
        let s = self.sets.get(set).ok_or("no such clip set")?;
        let retarget = s.standard.is_some() && b.is_humanoid();
        if retarget && !self.retargets.contains_key(&(body, set)) {
            let rt = Retarget::new(b, s.standard.as_ref().unwrap())?;
            self.retargets.insert((body, set), rt);
        }
        Ok(Animator::new(self, body, set, !retarget))
    }
    pub fn retarget(&self, body: usize, set: usize) -> Option<&Retarget> {
        self.retargets.get(&(body, set))
    }
    /// A body's joint by name (a humanoid name, or any joint's).
    pub fn bone(&self, body: usize, name: &str) -> Option<usize> {
        let b = self.bodies.get(body)?;
        humanoid::index(name).and_then(|h| b.humanoid[h]).or_else(|| b.by_name.get(name).copied())
    }
}

#[cfg(test)]
mod tests;
