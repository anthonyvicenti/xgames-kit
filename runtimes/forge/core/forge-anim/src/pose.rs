//! Local poses (`Trs`) and the bone palette (`PoseBuffer`): every animated entity's bone matrices this step, one flat
//! array of column-major 4×4 matrices (16 floats a bone) that the renderer uploads for skinning and the feel systems
//! read to place hurtboxes and ragdolls. An entity's bones are a contiguous range (`base`, `count`) in body joint
//! order (`Body::joints`).
use glam::{Mat4, Quat, Vec3};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trs {
    pub t: Vec3,
    pub r: Quat,
    pub s: Vec3,
}

impl Default for Trs {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Trs {
    pub const IDENTITY: Trs = Trs { t: Vec3::ZERO, r: Quat::IDENTITY, s: Vec3::ONE };
    pub fn mat(&self) -> Mat4 {
        Mat4::from_scale_rotation_translation(self.s, self.r, self.t)
    }
    pub fn from_mat(m: Mat4) -> Trs {
        let (s, r, t) = m.to_scale_rotation_translation();
        Trs { t, r: r.normalize(), s }
    }
    /// `a` toward `b` by `w` (0: a, 1: b): translations and scales lerp, rotations take the short way.
    pub fn blend(a: &Trs, b: &Trs, w: f32) -> Trs {
        if w <= 0.0 {
            return *a;
        }
        if w >= 1.0 {
            return *b;
        }
        Trs { t: a.t.lerp(b.t, w), r: a.r.slerp(b.r, w).normalize(), s: a.s.lerp(b.s, w) }
    }
}

/// The bone palette: `world` (each bone in its model's space, the scene the GLB defines) and `skin` (`world ×` the
/// joint's inverse bind matrix: what a skinning shader multiplies a vertex by, per the glTF spec, before the model's
/// own placement).
#[derive(Clone, Debug, Default)]
pub struct PoseBuffer {
    pub world: Vec<Mat4>,
    pub skin: Vec<Mat4>,
}

impl PoseBuffer {
    pub fn resize(&mut self, bones: usize) {
        self.world.resize(bones, Mat4::IDENTITY);
        self.skin.resize(bones, Mat4::IDENTITY);
    }
    pub fn len(&self) -> usize {
        self.world.len()
    }
    pub fn is_empty(&self) -> bool {
        self.world.is_empty()
    }
    /// One entity's world matrices.
    pub fn slice(&self, base: u32, count: u32) -> &[Mat4] {
        let (a, b) = (base as usize, base as usize + count as usize);
        self.world.get(a..b).unwrap_or(&[])
    }
    /// The world matrices as floats (16 a bone, column-major): what JS views as a Float32Array.
    pub fn world_floats(&self) -> &[f32] {
        floats(&self.world)
    }
    pub fn skin_floats(&self) -> &[f32] {
        floats(&self.skin)
    }
}

fn floats(m: &[Mat4]) -> &[f32] {
    // glam's Mat4 is #[repr(C)]: four Vec4 columns of four f32, nothing between them
    const _: () = assert!(std::mem::size_of::<Mat4>() == 64);
    unsafe { std::slice::from_raw_parts(m.as_ptr() as *const f32, m.len() * 16) }
}
