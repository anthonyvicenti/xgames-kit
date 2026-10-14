//! The look (every value a `look.*` slot in the game; `kit/look.js` declares them and packs them for the core).
//!
//! `set_look` takes wave 0's 22 floats (sky, fog, ambient, the moon light, exposure, render scale, pixelated), then the
//! track R extension: `EXT_MAGIC`, `EXT_VERSION`, the field count, `EXT_FIELDS` in order, the particle kind count, the
//! field count per kind and `KIND_FIELDS` per kind in `KINDS` order. A short pack keeps the defaults for what it lacks,
//! so an older `look.js` still draws. The names here and `PACK_EXT` / `PACK_KIND` in kit/look.js are held to the same
//! order by a test (`the_pack_order_matches_look_js`).
use crate::particles::{Kind, KINDS};

pub const EXT_MAGIC: f32 = 7301.0;
pub const EXT_VERSION: f32 = 1.0;

/// The extension's fields, in pack order (kit/look.js `PACK_EXT` names them the same way).
pub const EXT_FIELDS: [&str; 70] = [
    "fog.density",
    "sky.zenith.r",
    "sky.zenith.g",
    "sky.zenith.b",
    "sky.horizon.r",
    "sky.horizon.g",
    "sky.horizon.b",
    "sky.stars",
    "moon.disc.r",
    "moon.disc.g",
    "moon.disc.b",
    "moon.size",
    "moon.brightness",
    "moon.glow",
    "shadow.size",
    "shadow.distance",
    "shadow.strength",
    "shadow.bias",
    "bloom.intensity",
    "bloom.threshold",
    "bloom.knee",
    "bloom.radius",
    "tone.curve",
    "tone.contrast",
    "tone.saturation",
    "tone.gamma",
    "retro.texels",
    "retro.grain",
    "retro.dither",
    "retro.steps",
    "retro.snap",
    "detail",
    "aa",
    "lights.max",
    "hit.color.r",
    "hit.color.g",
    "hit.color.b",
    "hit.time",
    "hit.amount",
    "fp.fov",
    "fire.embers",
    "fire.smoke",
    "weather.ash",
    "particles.budget",
    "emissive",
    "vignette",
    "shadow.softness",
    // ---- wave 2 (track L1): appended, so an older look.js still packs what it knows ----
    "retro.density",
    "lights.falloff",
    "tracer.width",
    "tracer.length",
    "tracer.speed",
    "tracer.glow",
    "backdrop.distance",
    "backdrop.fog",
    "pieces.shadow",
    "pieces.distance",
    "fire.shadows",
    "fire.shadowSize",
    "fire.shadowFaces",
    "fire.shadowStrength",
    "retro.models",
    "retro.hand",
    "retro.crisp",
    "sky.haze",
    "tone.auto",
    "tone.key",
    "tone.autoMin",
    "tone.autoMax",
    "tone.adapt",
];

/// A particle kind's fields, in pack order (kit/look.js `PACK_KIND`).
pub const KIND_FIELDS: [&str; 18] = ["color.r", "color.g", "color.b", "alpha", "glow", "count", "life", "size0", "size1", "speed", "spread", "gravity", "drag", "additive", "stretch", "delay", "bounce", "spin"];

/// Tone curves (`tone.curve`).
pub const TONE_CLAMP: u32 = 0;
pub const TONE_ACES: u32 = 1;
pub const TONE_REINHARD: u32 = 2;

/// Every look value (colours linear).
#[derive(Clone, Debug)]
pub struct Look {
    // ---- wave 0 (set_look's first 22 values) ----
    pub sky: [f32; 3],
    pub fog: [f32; 3],
    pub fog_near: f32,
    pub fog_far: f32,
    pub ambient: [f32; 3],
    pub ambient_intensity: f32,
    pub sun_dir: [f32; 3],
    pub sun_color: [f32; 3],
    pub sun_intensity: f32,
    pub exposure: f32,
    pub render_scale: f32,
    pub pixelated: bool,
    // ---- track R: fog, sky and moon ----
    /// Exponential fog: 1 − e^(−density·d), on top of the linear near/far ramp (0: linear only).
    pub fog_density: f32,
    pub sky_zenith: [f32; 3],
    pub sky_horizon: [f32; 3],
    pub stars: f32,
    pub moon_disc: [f32; 3],
    /// The moon's angular radius (degrees; 0: no disc). It sits where the moon light comes from (`sun_dir`).
    pub moon_size: f32,
    /// The disc's brightness over 1 (HDR: it blooms).
    pub moon_brightness: f32,
    pub moon_glow: f32,
    // ---- shadows: the moon's one map ----
    /// The map's side in texels (0: no shadows).
    pub shadow_size: u32,
    /// How far from the eye shadows reach (m).
    pub shadow_distance: f32,
    /// 0: shadows do not darken, 1: the moon is fully blocked.
    pub shadow_strength: f32,
    /// Normal offset, in shadow texels.
    pub shadow_bias: f32,
    /// PCF radius, in shadow texels.
    pub shadow_softness: f32,
    // ---- bloom ----
    /// 0: no bloom passes.
    pub bloom_intensity: f32,
    pub bloom_threshold: f32,
    pub bloom_knee: f32,
    pub bloom_radius: f32,
    // ---- tone ----
    pub tone_curve: u32,
    pub contrast: f32,
    pub saturation: f32,
    pub gamma: f32,
    /// Edge-darkening at the frame's corners (0: none).
    pub vignette: f32,
    // ---- retro ----
    /// Textures magnify as square texels (nearest), not smoothed.
    pub retro_texels: bool,
    pub grain: f32,
    /// Ordered dither before the 8-bit (or colour-step) quantisation, in steps (0: none).
    pub dither: f32,
    /// Levels per colour channel (0: off; 8–64 reads retro).
    pub color_steps: f32,
    /// Vertex snap: lines of a virtual screen the vertices snap to (0: off; 240 reads PS1).
    pub vertex_snap: f32,
    /// The scene's internal width cap in pixels ("scene detail"; 0: no cap).
    pub detail: f32,
    /// Edge anti-aliasing (FXAA) on the final image.
    pub aa: bool,
    // ---- lights, hits, first person, particles ----
    /// Point lights shaded per frame (flashes first, then the nearest).
    pub max_lights: u32,
    pub hit_color: [f32; 3],
    /// A hit's body flash, seconds (≈ 3 frames at 0.05).
    pub hit_time: f32,
    /// How white the flash goes (0: no automatic flash on a HIT event).
    pub hit_amount: f32,
    /// The first-person layer's vertical field of view (degrees).
    pub fp_fov: f32,
    /// Embers a second from every fire light (the lights the host sets), and smoke puffs.
    pub fire_embers: f32,
    pub fire_smoke: f32,
    /// Ash flakes a second drifting down around the eye.
    pub weather_ash: f32,
    pub particle_budget: u32,
    /// A multiplier on every material's emissive (eyes, coals).
    pub emissive: f32,
    // ---- wave 2 (track L1) ----
    /// The retro texel grid: texels a metre of surface shows when `retro_texels` is on (a picture finer than that is
    /// averaged into them; one coarser shows its own). 0: every picture's own texels. `retro_density` is for surfaces
    /// the world lays a tiling picture on (ground, walls), `retro_models` for anything with its own UVs (props,
    /// bodies, held weapons), `retro_hand` for the first-person layer.
    pub retro_density: f32,
    pub retro_models: f32,
    pub retro_hand: f32,
    /// How a texel of the grid takes its colour from a finer picture: 0 the average of what it covers (soft, even),
    /// 1 the picture's one texel at its middle (gritty: neighbours differ more, as a picture cut down by dropping
    /// pixels does).
    pub retro_crisp: f32,
    /// The eye adapts: the picture's mean brightness is metered every frame (96 points of the scene through the tone
    /// curve) and the exposure is steered so it comes to `tone_key` (a mean luma, 0..255: the look target's 34–48),
    /// by at most `tone_auto_min`..`tone_auto_max` times the look's own exposure, over about `tone_adapt` seconds
    /// when the picture got brighter and four times that when it got darker (at once on the first frames and after
    /// a cut). `tone_auto` is how far it goes (0: off, the exposure as set; 1: all the way to the key).
    pub tone_auto: f32,
    pub tone_key: f32,
    pub tone_auto_min: f32,
    pub tone_auto_max: f32,
    pub tone_adapt: f32,
    /// How high the horizon's colour reaches up the sky (0: wave 1's quick fade to the zenith; 1: a wide band of haze,
    /// which far things fade into: what stands beyond the walls reads as silhouettes against it).
    pub sky_haze: f32,
    /// A point light's knee as a share of its reach: brightness is q² / (1 + (d / knee)²), q = 1 − (d / reach)⁴, the
    /// knee `falloff` × reach and never under 1 m (wave 1's lights; a muzzle flash keeps that). Larger: a wider pool
    /// under a fire.
    pub light_falloff: f32,
    /// Tracers (forge-feel's event 33 and rounds in flight): the least a streak is wide (m), its length (m), how fast
    /// a hitscan streak crosses its line (m/s), and its brightness over 1 (it blooms).
    pub tracer_width: f32,
    pub tracer_length: f32,
    pub tracer_speed: f32,
    pub tracer_glow: f32,
    /// The backdrop layer (`Instance::backdrop`: trees and ruins beyond the walls): not drawn past this distance from
    /// the eye (m; 0: always), and its fog thickened this many times, so the ring reads as silhouettes.
    pub backdrop_distance: f32,
    pub backdrop_fog: f32,
    /// Rigid pieces at rest (a kill's debris, coins): beyond this distance from the eye they cast no shadow (m), and
    /// beyond `pieces_distance` they are not drawn (m; 0: always drawn).
    pub pieces_shadow: f32,
    pub pieces_distance: f32,
    /// Fire shadows: how many of the nearest fire lights cast one (0: none; at most `MAX_FIRE_SHADOWS`), the side of
    /// a cube face in texels, how many faces are drawn again each frame, and how dark (0..1).
    pub fire_shadows: u32,
    pub fire_shadow_size: u32,
    pub fire_shadow_faces: u32,
    pub fire_shadow_strength: f32,
    pub kinds: Vec<Kind>,
}

impl Default for Look {
    fn default() -> Self {
        let sky = [0.02, 0.02, 0.03];
        Self {
            sky,
            fog: sky,
            fog_near: 4.0,
            fog_far: 24.0,
            ambient: [0.5, 0.5, 0.6],
            ambient_intensity: 0.25,
            sun_dir: [0.3, 1.0, 0.2],
            sun_color: [0.7, 0.75, 1.0],
            sun_intensity: 0.15,
            exposure: 1.0,
            render_scale: 1.0,
            pixelated: false,
            fog_density: 0.0,
            sky_zenith: sky,
            sky_horizon: sky,
            stars: 0.0,
            moon_disc: [0.9, 0.92, 1.0],
            moon_size: 0.0,
            moon_brightness: 4.0,
            moon_glow: 0.0,
            shadow_size: 0,
            shadow_distance: 30.0,
            shadow_strength: 1.0,
            shadow_bias: 1.5,
            shadow_softness: 1.0,
            bloom_intensity: 0.0,
            bloom_threshold: 1.0,
            bloom_knee: 0.5,
            bloom_radius: 1.0,
            tone_curve: TONE_CLAMP,
            contrast: 1.0,
            saturation: 1.0,
            gamma: 1.0,
            vignette: 0.0,
            retro_texels: false,
            grain: 0.0,
            dither: 0.0,
            color_steps: 0.0,
            vertex_snap: 0.0,
            detail: 0.0,
            aa: false,
            max_lights: 16,
            hit_color: [1.0, 1.0, 1.0],
            hit_time: 0.05,
            hit_amount: 1.0,
            fp_fov: 54.0,
            fire_embers: 0.0,
            fire_smoke: 0.0,
            weather_ash: 0.0,
            particle_budget: 2048,
            emissive: 1.0,
            retro_density: 0.0,
            retro_models: 0.0,
            retro_hand: 0.0,
            retro_crisp: 0.0,
            tone_auto: 0.0,
            tone_key: 41.0,
            tone_auto_min: 0.3,
            tone_auto_max: 1.6,
            tone_adapt: 0.3,
            sky_haze: 0.0,
            light_falloff: 0.0,
            tracer_width: 0.02,
            tracer_length: 3.0,
            tracer_speed: 220.0,
            tracer_glow: 6.0,
            backdrop_distance: 0.0,
            backdrop_fog: 1.0,
            pieces_shadow: 0.0,
            pieces_distance: 0.0,
            fire_shadows: 0,
            fire_shadow_size: 256,
            fire_shadow_faces: 4,
            fire_shadow_strength: 0.85,
            kinds: KINDS.iter().map(|k| k.default_kind()).collect(),
        }
    }
}

fn fin(v: f32, d: f32) -> f32 {
    if v.is_finite() { v } else { d }
}

impl Look {
    /// Wave 0's 22 values (forge-web `set_look`).
    pub fn set_base(&mut self, v: &[f32]) {
        if v.len() < 22 {
            return;
        }
        self.sky = [v[0], v[1], v[2]];
        self.fog = [v[3], v[4], v[5]];
        self.fog_near = v[6];
        self.fog_far = v[7];
        self.ambient = [v[8], v[9], v[10]];
        self.ambient_intensity = v[11];
        self.sun_dir = [v[12], v[13], v[14]];
        self.sun_color = [v[15], v[16], v[17]];
        self.sun_intensity = v[18];
        self.exposure = v[19];
        self.render_scale = v[20].clamp(0.1, 1.0);
        self.pixelated = v[21] > 0.5;
    }

    /// The track R extension (the floats after wave 0's 22). Without it (an older look.js), the stack stays off: the
    /// sky is wave 0's flat colour and no bloom, shadows or retro pass run. → whether it was read.
    pub fn set_ext(&mut self, v: &[f32]) -> bool {
        let d = Look::default();
        if v.len() < 3 || v[0] != EXT_MAGIC || v[1] < 1.0 {
            // no extension: wave 0's look as it was, the sky gradient flat at the sky colour
            self.sky_zenith = self.sky;
            self.sky_horizon = self.sky;
            return false;
        }
        let n = (v[2].max(0.0) as usize).min(v.len().saturating_sub(3));
        let f = &v[3..3 + n];
        let g = |i: usize, dflt: f32| fin(f.get(i).copied().unwrap_or(dflt), dflt);
        let rgb = |i: usize, dflt: [f32; 3]| [g(i, dflt[0]).max(0.0), g(i + 1, dflt[1]).max(0.0), g(i + 2, dflt[2]).max(0.0)];
        self.fog_density = g(0, d.fog_density).clamp(0.0, 2.0);
        self.sky_zenith = rgb(1, self.sky);
        self.sky_horizon = rgb(4, self.fog);
        self.stars = g(7, 0.0).clamp(0.0, 4.0);
        self.moon_disc = rgb(8, d.moon_disc);
        self.moon_size = g(11, 0.0).clamp(0.0, 20.0);
        self.moon_brightness = g(12, d.moon_brightness).clamp(0.0, 100.0);
        self.moon_glow = g(13, 0.0).clamp(0.0, 8.0);
        self.shadow_size = g(14, 0.0).clamp(0.0, 4096.0) as u32;
        self.shadow_distance = g(15, d.shadow_distance).clamp(2.0, 400.0);
        self.shadow_strength = g(16, 1.0).clamp(0.0, 1.0);
        self.shadow_bias = g(17, d.shadow_bias).clamp(0.0, 16.0);
        self.bloom_intensity = g(18, 0.0).clamp(0.0, 8.0);
        self.bloom_threshold = g(19, d.bloom_threshold).clamp(0.0, 64.0);
        self.bloom_knee = g(20, d.bloom_knee).clamp(0.0, 4.0);
        self.bloom_radius = g(21, 1.0).clamp(0.1, 4.0);
        self.tone_curve = g(22, 0.0).clamp(0.0, 2.0) as u32;
        self.contrast = g(23, 1.0).clamp(0.2, 3.0);
        self.saturation = g(24, 1.0).clamp(0.0, 3.0);
        self.gamma = g(25, 1.0).clamp(0.3, 3.0);
        self.retro_texels = g(26, 0.0) > 0.5;
        self.grain = g(27, 0.0).clamp(0.0, 1.0);
        self.dither = g(28, 0.0).clamp(0.0, 4.0);
        self.color_steps = g(29, 0.0).clamp(0.0, 256.0);
        self.vertex_snap = g(30, 0.0).clamp(0.0, 4096.0);
        self.detail = g(31, 0.0).clamp(0.0, 8192.0);
        self.aa = g(32, 0.0) > 0.5;
        self.max_lights = g(33, d.max_lights as f32).clamp(0.0, crate::MAX_SHADER_LIGHTS as f32) as u32;
        self.hit_color = rgb(34, d.hit_color);
        self.hit_time = g(37, d.hit_time).clamp(0.0, 1.0);
        self.hit_amount = g(38, d.hit_amount).clamp(0.0, 1.0);
        self.fp_fov = g(39, d.fp_fov).clamp(20.0, 120.0);
        self.fire_embers = g(40, 0.0).clamp(0.0, 200.0);
        self.fire_smoke = g(41, 0.0).clamp(0.0, 100.0);
        self.weather_ash = g(42, 0.0).clamp(0.0, 2000.0);
        self.particle_budget = g(43, d.particle_budget as f32).clamp(0.0, crate::particles::MAX_PARTICLES as f32) as u32;
        self.emissive = g(44, 1.0).clamp(0.0, 16.0);
        self.vignette = g(45, 0.0).clamp(0.0, 2.0);
        self.shadow_softness = g(46, d.shadow_softness).clamp(0.0, 4.0);
        // wave 2: a pack without these (wave 1's look.js) keeps wave 1's picture (the pictures' own texels, the
        // inverse-square lights, no fire shadows)
        self.retro_density = g(47, d.retro_density).clamp(0.0, 1024.0);
        self.light_falloff = g(48, d.light_falloff).clamp(0.0, 4.0);
        self.tracer_width = g(49, d.tracer_width).clamp(0.0, 1.0);
        self.tracer_length = g(50, d.tracer_length).clamp(0.05, 100.0);
        self.tracer_speed = g(51, d.tracer_speed).clamp(1.0, 5000.0);
        self.tracer_glow = g(52, d.tracer_glow).clamp(0.0, 64.0);
        self.backdrop_distance = g(53, d.backdrop_distance).clamp(0.0, 10000.0);
        self.backdrop_fog = g(54, d.backdrop_fog).clamp(0.0, 16.0);
        self.pieces_shadow = g(55, d.pieces_shadow).clamp(0.0, 10000.0);
        self.pieces_distance = g(56, d.pieces_distance).clamp(0.0, 10000.0);
        self.fire_shadows = g(57, 0.0).clamp(0.0, crate::MAX_FIRE_SHADOWS as f32) as u32;
        self.fire_shadow_size = (g(58, d.fire_shadow_size as f32).clamp(32.0, 512.0) as u32).next_power_of_two().min(512);
        self.fire_shadow_faces = g(59, d.fire_shadow_faces as f32).clamp(1.0, 24.0) as u32;
        self.fire_shadow_strength = g(60, d.fire_shadow_strength).clamp(0.0, 1.0);
        self.retro_models = g(61, d.retro_models).clamp(0.0, 4096.0);
        self.retro_hand = g(62, d.retro_hand).clamp(0.0, 4096.0);
        self.retro_crisp = g(63, d.retro_crisp).clamp(0.0, 1.0);
        self.sky_haze = g(64, d.sky_haze).clamp(0.0, 1.0);
        self.tone_auto = g(65, d.tone_auto).clamp(0.0, 1.0);
        self.tone_key = g(66, d.tone_key).clamp(1.0, 254.0);
        self.tone_auto_min = g(67, d.tone_auto_min).clamp(0.01, 1.0);
        self.tone_auto_max = g(68, d.tone_auto_max).clamp(1.0, 100.0);
        self.tone_adapt = g(69, d.tone_adapt).clamp(0.0, 30.0);
        // the particle kinds
        let rest = &v[3 + n..];
        if rest.len() >= 2 {
            let (count, per) = (rest[0].max(0.0) as usize, rest[1].max(0.0) as usize);
            let body = &rest[2..];
            for k in 0..count.min(KINDS.len()) {
                if body.len() >= (k + 1) * per && per > 0 {
                    self.kinds[k] = Kind::from_fields(&body[k * per..(k + 1) * per], &KINDS[k].default_kind());
                }
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// kit/look.js names the same fields in the same order (`PACK_EXT`, `PACK_KIND`, `KIND_IDS`): read its source.
    #[test]
    fn the_pack_order_matches_look_js() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../kit/look.js");
        let Ok(src) = std::fs::read_to_string(path) else { panic!("no kit/look.js at {path}") };
        let list = |name: &str| -> Vec<String> {
            let at = src.find(&format!("export const {name} = [")).unwrap_or_else(|| panic!("look.js has no {name}"));
            let body = &src[at..];
            let end = body.find("];").unwrap();
            body[..end].split('\'').skip(1).step_by(2).map(str::to_string).collect()
        };
        assert_eq!(list("PACK_EXT"), EXT_FIELDS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(list("PACK_KIND"), KIND_FIELDS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(list("KIND_IDS"), KINDS.iter().map(|k| k.id.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn a_short_or_missing_extension_keeps_the_defaults() {
        let mut l = Look::default();
        l.sky = [0.1, 0.2, 0.3];
        assert!(!l.set_ext(&[]));
        assert_eq!(l.sky_zenith, [0.1, 0.2, 0.3]);
        assert_eq!(l.shadow_size, 0);
        let mut l = Look::default();
        assert!(l.set_ext(&[EXT_MAGIC, 1.0, 1.0, 0.019]));
        assert!((l.fog_density - 0.019).abs() < 1e-6);
        assert_eq!(l.bloom_intensity, 0.0);
        assert_eq!(l.kinds.len(), KINDS.len());
    }
}
