//! glTF 2.0 binary (GLB) → meshes, from bytes. Content is never compiled in (PLAN §2): every model arrives as a slot
//! file's bytes. Accessors of any component type are read (KHR_mesh_quantization: normalized or plain integers,
//! dequantised by the node transforms as the spec says); sparse accessors and external buffers are refused with a
//! reason. Images are handed back still encoded, for the host to decode (the browser's own PNG/JPEG/WebP decoders: no
//! image codec in the wasm). EXT_meshopt_compression is decoded by the host before the bytes get here.
//!
//! Track R adds what bodies and the first-person layer need:
//! - **Skins.** A primitive on a skinned node keeps JOINTS_0 and WEIGHTS_0 (`MeshData::skin`, indices into its file
//!   skin's joint list until a body binds them, `Scene::bind_body`) and its vertices as the file has them: per the
//!   glTF spec a skinned mesh node's own placement is ignored (each vertex goes through joint world × inverse bind
//!   alone), which is what three.js does too (GLTFLoader binds with the identity, and an attached SkinnedMesh's
//!   bindMatrixInverse cancels its matrixWorld). Baking the node's placement in drew KayKit bodies (mesh nodes with
//!   their own transforms) in pieces; the grim set's mesh nodes are identity, so it did not show there.
//! - **Nodes.** The node table (names, parents, local transforms) and the node each primitive hangs on, so a body's
//!   rigid pieces on a bone (a helmet on the Head) follow that bone, the first-person arms move `arm_r` and `arm_l`,
//!   and sockets (`socket_muzzle`, `socket_tip`, `socket_grip`) are found by name.
//! - **Materials.** Emissive colour × KHR_materials_emissive_strength (enemy eyes, brazier coals), the material's name
//!   (`glow_eyes` takes a per-instance glow), double-sided and alpha-mask; an emissive map (the Meshy art's `glow_tip`,
//!   `glow_coals` and `glow_flame` keep their base picture as it: `emissive_map`, drawn as emissive × the picture).
//! - **Extras** (the wave 1b integration, for the art library after tracks C2 and C3): a node with `gfHidden: true` is
//!   not drawn until something shows it (a gun's `flash_muzzle`, shown for 2–4 frames a shot), nor is anything under
//!   it; `gfTint` (the materials that take the player colour: the hunters' `player_tint`) and `gfTintMix` on any node
//!   (the body's `gf_body`).
use glam::{Mat3, Mat4, Vec3};
use gltf::accessor::{DataType, Dimensions};

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Vertex {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
}

/// A skinned vertex's bones and weights (beside its `Vertex`): four joints (indices into the bone palette range of the
/// body once bound) and their weights, summing to 1.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SkinVertex {
    pub joints: [u16; 4],
    pub weights: [f32; 4],
}

#[derive(Clone, Debug, Default)]
pub struct MeshData {
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
    pub min: Vec3,
    pub max: Vec3,
    /// Skinned primitives only: one entry per vertex.
    pub skin: Option<Vec<SkinVertex>>,
    /// How much of its picture a metre of this mesh's surface spans (UV units a metre, in the mesh's own space; 0: no
    /// UVs, or every face on one point of the picture: a palette swatch). The retro texel look turns it into a texel
    /// grid at the look's density (`uv_density`).
    pub uv_per_m: f32,
    /// Its UVs reach past one picture (they span more than a unit and a half): a tiling surface (a ground, a wall),
    /// not a model unwrapped onto its own picture. The retro look gives it the world's texel density.
    pub uv_tiles: bool,
}

/// Whether a mesh's UVs repeat its picture: they span more than a unit and a half one way or the other.
pub fn uv_repeats(vertices: &[Vertex]) -> bool {
    let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
    for v in vertices {
        for k in 0..2 {
            if v.uv[k].is_finite() {
                lo[k] = lo[k].min(v.uv[k]);
                hi[k] = hi[k].max(v.uv[k]);
            }
        }
    }
    (0..2).any(|k| hi[k] - lo[k] > 1.5)
}

/// UV units per metre of surface over a mesh: the square root of its UV area over its surface area (area weighted, so
/// the large faces decide). A face mapped onto a point or a line of the picture adds its surface and no UV area.
pub fn uv_density(vertices: &[Vertex], indices: &[u32]) -> f32 {
    let (mut uv_area, mut area) = (0f64, 0f64);
    for t in indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (vertices.get(t[0] as usize), vertices.get(t[1] as usize), vertices.get(t[2] as usize)) else { continue };
        let (pa, pb, pc) = (Vec3::from(a.pos), Vec3::from(b.pos), Vec3::from(c.pos));
        area += ((pb - pa).cross(pc - pa).length() * 0.5) as f64;
        let (ux, uy, vx, vy) = (b.uv[0] - a.uv[0], b.uv[1] - a.uv[1], c.uv[0] - a.uv[0], c.uv[1] - a.uv[1]);
        uv_area += ((ux * vy - uy * vx).abs() * 0.5) as f64;
    }
    if area <= 1e-12 || uv_area <= 1e-12 { 0.0 } else { (uv_area / area).sqrt() as f32 }
}

#[derive(Clone, Debug)]
pub struct PrimData {
    pub mesh: MeshData,
    /// The node's transform in the model (identity for a skinned primitive: its vertices are baked).
    pub local: Mat4,
    pub base: [f32; 4],
    /// The base-colour image (an index into `ModelData::images`).
    pub image: Option<usize>,
    /// Emissive colour × strength (linear, HDR).
    pub emissive: [f32; 3],
    /// The material has an emissive map: its emissive is that colour × the picture. The base-colour picture stands in
    /// for it (every library file's emissive map is its base picture; `emissive_map_other` says when a file's is not).
    pub emissive_map: bool,
    pub emissive_map_other: bool,
    /// The emissive map when it is another picture than the base colour's (an index into `ModelData::images`): drawn
    /// as emissive × that picture.
    pub emissive_image: Option<usize>,
    /// Under a `gfHidden` node (that node's index): not drawn until it is shown.
    pub hidden: Option<usize>,
    pub material: String,
    pub double_sided: bool,
    /// alphaMode MASK: discard below this.
    pub alpha_cutoff: Option<f32>,
    /// The node the mesh hangs on (an index into `ModelData::nodes`).
    pub node: usize,
    /// The file skin this primitive is skinned by (an index into `ModelData::skins`).
    pub skin: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct NodeData {
    pub name: String,
    pub parent: Option<usize>,
    pub local: Mat4,
    /// extras `gfHidden: true`.
    pub hidden: bool,
}

#[derive(Clone, Debug)]
pub struct ImageRef {
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct ModelData {
    pub prims: Vec<PrimData>,
    pub images: Vec<ImageRef>,
    pub min: Vec3,
    pub max: Vec3,
    pub nodes: Vec<NodeData>,
    /// Per file skin: its joints as node indices, in the skin's order (what JOINTS_0 indexes).
    pub skins: Vec<Vec<usize>>,
    /// Per file skin: each joint's inverse bind matrix. Skins of one body may differ here (KayKit: one skin per piece,
    /// each with its piece's own bind space), so a body is skinned per skin, never with one matrix per joint.
    pub skin_ibms: Vec<Vec<Mat4>>,
    /// extras `gfTint`: the materials that take the player colour (beside every `tint_*` one), and `gfTintMix`: how
    /// far toward it (None: the renderer's 0.85).
    pub tint: Vec<String>,
    pub tint_mix: Option<f32>,
}

impl ModelData {
    /// A node's transform in the model (its chain of locals up to the scene).
    pub fn node_world(&self, mut n: usize) -> Mat4 {
        let mut m = Mat4::IDENTITY;
        for _ in 0..self.nodes.len() {
            let Some(node) = self.nodes.get(n) else { break };
            m = node.local * m;
            match node.parent {
                Some(p) => n = p,
                None => break,
            }
        }
        m
    }
    pub fn node_named(&self, name: &str) -> Option<usize> {
        self.nodes.iter().position(|n| n.name == name)
    }
}

pub fn parse(bytes: &[u8]) -> Result<ModelData, String> {
    let g = gltf::Gltf::from_slice_without_validation(bytes).map_err(|e| format!("not a glTF 2.0 binary: {e}"))?;
    for ext in g.extensions_required() {
        if ext != "KHR_mesh_quantization" && ext != "KHR_materials_emissive_strength" {
            return Err(format!("needs {ext}, which gf-forge cannot read (decode EXT_meshopt_compression before parse)"));
        }
    }
    let blob = g.blob.as_deref();
    let data_of = |b: gltf::Buffer| -> Result<&[u8], String> {
        match b.source() {
            gltf::buffer::Source::Bin => blob.ok_or_else(|| "the GLB has no binary chunk".to_string()),
            gltf::buffer::Source::Uri(u) => Err(format!("buffer {} is an external or data URI ({}...): pack it as one .glb", b.index(), &u[..u.len().min(24)])),
        }
    };
    let mut images = Vec::new();
    for img in g.images() {
        match img.source() {
            gltf::image::Source::View { view, mime_type } => {
                let d = data_of(view.buffer())?;
                let (a, n) = (view.offset(), view.length());
                if a + n > d.len() {
                    return Err(format!("image {} runs past the buffer", img.index()));
                }
                images.push(ImageRef { mime: mime_type.to_string(), bytes: d[a..a + n].to_vec() });
            }
            gltf::image::Source::Uri { uri, .. } => return Err(format!("image {} is an external URI ({}): pack it into the .glb", img.index(), &uri[..uri.len().min(24)])),
        }
    }
    // the node table: names, parents, locals
    let count = g.nodes().count();
    let extras_of = |n: &gltf::Node| -> Option<serde_json::Value> { n.extras().as_ref().and_then(|r| serde_json::from_str(r.get()).ok()) };
    let mut nodes: Vec<NodeData> = g.nodes().map(|n| NodeData { name: n.name().map(str::to_string).unwrap_or_else(|| format!("node{}", n.index())), parent: None, local: Mat4::from_cols_array_2d(&n.transform().matrix()), hidden: false }).collect();
    let (mut tint, mut tint_mix): (Vec<String>, Option<f32>) = (Vec::new(), None);
    for n in g.nodes() {
        for c in n.children() {
            if c.index() < count {
                nodes[c.index()].parent = Some(n.index());
            }
        }
        if let Some(x) = extras_of(&n) {
            nodes[n.index()].hidden = x.get("gfHidden").and_then(|v| v.as_bool()).unwrap_or(false);
            if let Some(list) = x.get("gfTint").and_then(|v| v.as_array()) {
                tint.extend(list.iter().filter_map(|v| v.as_str()).map(str::to_string));
                tint_mix = x.get("gfTintMix").and_then(|v| v.as_f64()).map(|v| (v as f32).clamp(0.0, 1.0)).or(tint_mix);
            }
        }
    }
    // the hidden node a node hangs under (itself, or the nearest above)
    let hidden_of = |mut n: usize| -> Option<usize> {
        for _ in 0..=nodes.len() {
            let d = nodes.get(n)?;
            if d.hidden {
                return Some(n);
            }
            n = d.parent?;
        }
        None
    };
    let skins: Vec<Vec<usize>> = g.skins().map(|s| s.joints().map(|j| j.index()).collect()).collect();
    let mut skin_ibms = Vec::new();
    for s in g.skins() {
        let n = s.joints().count();
        let mats: Vec<Mat4> = match s.inverse_bind_matrices() {
            Some(a) => read_floats(&a, 16, &data_of)?.chunks_exact(16).map(Mat4::from_cols_slice).collect(),
            None => Vec::new(),
        };
        skin_ibms.push((0..n).map(|k| mats.get(k).copied().unwrap_or(Mat4::IDENTITY)).collect::<Vec<_>>());
    }
    let scene = g.default_scene().or_else(|| g.scenes().next()).ok_or("the glTF has no scene")?;
    let mut prims = Vec::new();
    let mut stack: Vec<(gltf::Node, Mat4)> = scene.nodes().map(|n| (n, Mat4::IDENTITY)).collect();
    stack.reverse();
    while let Some((node, parent)) = stack.pop() {
        let m = parent * Mat4::from_cols_array_2d(&node.transform().matrix());
        if let Some(mesh) = node.mesh() {
            let skin = node.skin().map(|s| s.index());
            for p in mesh.primitives() {
                if p.mode() != gltf::mesh::Mode::Triangles {
                    continue;
                }
                let mut prim = read_prim(&p, m, node.index(), skin, &data_of)?;
                prim.hidden = hidden_of(node.index());
                prims.push(prim);
            }
        }
        let kids: Vec<_> = node.children().collect();
        for c in kids.into_iter().rev() {
            stack.push((c, m));
        }
    }
    if prims.is_empty() {
        return Err("the glTF has no triangle meshes".into());
    }
    let (mut min, mut max) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    let any_shown = prims.iter().any(|p| p.hidden.is_none());
    for p in prims.iter().filter(|p| p.hidden.is_none() || !any_shown) {
        for c in corners(p.mesh.min, p.mesh.max) {
            let w = p.local.transform_point3(c);
            min = min.min(w);
            max = max.max(w);
        }
    }
    Ok(ModelData { prims, images, min, max, nodes, skins, skin_ibms, tint, tint_mix })
}

pub fn corners(min: Vec3, max: Vec3) -> [Vec3; 8] {
    [
        Vec3::new(min.x, min.y, min.z),
        Vec3::new(max.x, min.y, min.z),
        Vec3::new(min.x, max.y, min.z),
        Vec3::new(max.x, max.y, min.z),
        Vec3::new(min.x, min.y, max.z),
        Vec3::new(max.x, min.y, max.z),
        Vec3::new(min.x, max.y, max.z),
        Vec3::new(max.x, max.y, max.z),
    ]
}

/// Bake a transform into a mesh's vertices (positions and normals) and refresh its box.
pub fn bake(mesh: &mut MeshData, m: Mat4) {
    if m == Mat4::IDENTITY {
        return;
    }
    let nm = Mat3::from_mat4(m).inverse().transpose();
    let (mut min, mut max) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for v in mesh.vertices.iter_mut() {
        let p = m.transform_point3(Vec3::from(v.pos));
        v.pos = p.into();
        v.normal = (nm * Vec3::from(v.normal)).normalize_or(Vec3::Y).into();
        min = min.min(p);
        max = max.max(p);
    }
    if !mesh.vertices.is_empty() {
        mesh.min = min;
        mesh.max = max;
    }
    mesh.uv_per_m = uv_density(&mesh.vertices, &mesh.indices);
}

fn read_prim<'a>(p: &gltf::Primitive<'a>, world: Mat4, node: usize, skin: Option<usize>, data_of: &dyn Fn(gltf::Buffer<'a>) -> Result<&'a [u8], String>) -> Result<PrimData, String> {
    let pos_acc = p.get(&gltf::Semantic::Positions).ok_or("a primitive without POSITION")?;
    let pos = read_floats(&pos_acc, 3, data_of)?;
    let n = pos.len() / 3;
    let normal = match p.get(&gltf::Semantic::Normals) {
        Some(a) => Some(read_floats(&a, 3, data_of)?),
        None => None,
    };
    let uv = match p.get(&gltf::Semantic::TexCoords(0)) {
        Some(a) => Some(read_floats(&a, 2, data_of)?),
        None => None,
    };
    let indices: Vec<u32> = match p.indices() {
        Some(a) => read_indices(&a, data_of)?,
        None => (0..n as u32).collect(),
    };
    if indices.iter().any(|&i| i as usize >= n) {
        return Err("an index points past the vertices".into());
    }
    let mut vertices: Vec<Vertex> = (0..n).map(|i| Vertex { pos: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], normal: [0.0, 1.0, 0.0], uv: [0.0, 0.0] }).collect();
    if let Some(nm) = normal.filter(|v| v.len() == n * 3) {
        for (i, v) in vertices.iter_mut().enumerate() {
            let x = Vec3::new(nm[i * 3], nm[i * 3 + 1], nm[i * 3 + 2]).normalize_or(Vec3::Y);
            v.normal = x.into();
        }
    } else {
        // no normals: each vertex gets the sum of its faces'
        let mut acc = vec![Vec3::ZERO; n];
        for t in indices.chunks_exact(3) {
            let [a, b, c] = [t[0] as usize, t[1] as usize, t[2] as usize];
            let (pa, pb, pc) = (Vec3::from(vertices[a].pos), Vec3::from(vertices[b].pos), Vec3::from(vertices[c].pos));
            let f = (pb - pa).cross(pc - pa);
            acc[a] += f;
            acc[b] += f;
            acc[c] += f;
        }
        for (v, a) in vertices.iter_mut().zip(acc) {
            v.normal = a.normalize_or(Vec3::Y).into();
        }
    }
    if let Some(t) = uv.filter(|v| v.len() == n * 2) {
        for (i, v) in vertices.iter_mut().enumerate() {
            v.uv = [t[i * 2], t[i * 2 + 1]];
        }
    }
    // a skinned primitive: its bones and weights
    let mut skin_data = None;
    if skin.is_some()
        && let (Some(ja), Some(wa)) = (p.get(&gltf::Semantic::Joints(0)), p.get(&gltf::Semantic::Weights(0)))
    {
        let joints = read_floats(&ja, 4, data_of)?;
        let weights = read_floats(&wa, 4, data_of)?;
        if joints.len() == n * 4 && weights.len() == n * 4 {
            let mut out = Vec::with_capacity(n);
            for i in 0..n {
                let mut w = [weights[i * 4], weights[i * 4 + 1], weights[i * 4 + 2], weights[i * 4 + 3]];
                let s: f32 = w.iter().map(|x| x.max(0.0)).sum();
                if s > 1e-6 {
                    for x in w.iter_mut() {
                        *x = x.max(0.0) / s;
                    }
                } else {
                    w = [1.0, 0.0, 0.0, 0.0];
                }
                let j = [joints[i * 4] as u16, joints[i * 4 + 1] as u16, joints[i * 4 + 2] as u16, joints[i * 4 + 3] as u16];
                out.push(SkinVertex { joints: j, weights: w });
            }
            skin_data = Some(out);
        }
    }
    let skinned = skin_data.is_some();
    let (mut min, mut max) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for v in &vertices {
        min = min.min(Vec3::from(v.pos));
        max = max.max(Vec3::from(v.pos));
    }
    let uv_per_m = uv_density(&vertices, &indices);
    let uv_tiles = uv_repeats(&vertices);
    let mesh = MeshData { vertices, indices, min, max, skin: skin_data, uv_per_m, uv_tiles };
    // a skinned primitive's vertices are in the skeleton's bind space already: its node's placement is not applied
    let local = if skinned { Mat4::IDENTITY } else { world };
    let mat = p.material();
    let pbr = mat.pbr_metallic_roughness();
    let image = pbr.base_color_texture().map(|t| t.texture().source().index());
    let strength = mat.emissive_strength().unwrap_or(1.0);
    let e = mat.emissive_factor();
    let emissive_image = mat.emissive_texture().map(|t| t.texture().source().index());
    let alpha_cutoff = if mat.alpha_mode() == gltf::material::AlphaMode::Mask { Some(mat.alpha_cutoff().unwrap_or(0.5)) } else { None };
    Ok(PrimData {
        mesh,
        local,
        base: pbr.base_color_factor(),
        image,
        emissive: [e[0] * strength, e[1] * strength, e[2] * strength],
        emissive_map: emissive_image.is_some() && emissive_image == image,
        emissive_map_other: emissive_image.is_some() && emissive_image != image,
        emissive_image: emissive_image.filter(|e| Some(*e) != image),
        hidden: None,
        material: mat.name().unwrap_or("").to_string(),
        double_sided: mat.double_sided(),
        alpha_cutoff,
        node,
        skin: if skinned { skin } else { None },
    })
}

fn comps_of(d: Dimensions) -> usize {
    match d {
        Dimensions::Scalar => 1,
        Dimensions::Vec2 => 2,
        Dimensions::Vec3 => 3,
        Dimensions::Vec4 => 4,
        Dimensions::Mat2 => 4,
        Dimensions::Mat3 => 9,
        Dimensions::Mat4 => 16,
    }
}

fn size_of(t: DataType) -> usize {
    match t {
        DataType::I8 | DataType::U8 => 1,
        DataType::I16 | DataType::U16 => 2,
        DataType::U32 | DataType::F32 => 4,
    }
}

/// The raw element bytes of an accessor: (data, first byte, stride, element size, count).
fn layout<'a>(a: &gltf::Accessor<'a>, data_of: &dyn Fn(gltf::Buffer<'a>) -> Result<&'a [u8], String>) -> Result<(&'a [u8], usize, usize, usize, usize), String> {
    if a.sparse().is_some() {
        return Err(format!("accessor {} is sparse, which gf-forge does not read", a.index()));
    }
    let view = a.view().ok_or_else(|| format!("accessor {} has no buffer view", a.index()))?;
    let data = data_of(view.buffer())?;
    let elem = size_of(a.data_type()) * comps_of(a.dimensions());
    let stride = view.stride().unwrap_or(elem).max(elem);
    let first = view.offset() + a.offset();
    let count = a.count();
    if count > 0 {
        let end = first + stride * (count - 1) + elem;
        if end > view.offset() + view.length() || end > data.len() {
            return Err(format!("accessor {} runs past its buffer view", a.index()));
        }
    }
    Ok((data, first, stride, elem, count))
}

fn read_floats<'a>(a: &gltf::Accessor<'a>, want: usize, data_of: &dyn Fn(gltf::Buffer<'a>) -> Result<&'a [u8], String>) -> Result<Vec<f32>, String> {
    let comps = comps_of(a.dimensions());
    if comps < want {
        return Err(format!("accessor {} has {} components, needs {}", a.index(), comps, want));
    }
    let (data, first, stride, _, count) = layout(a, data_of)?;
    let t = a.data_type();
    let cs = size_of(t);
    let norm = a.normalized();
    let mut out = Vec::with_capacity(count * want);
    for i in 0..count {
        for c in 0..want {
            let at = first + i * stride + c * cs;
            let b = &data[at..at + cs];
            let v = match t {
                DataType::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                DataType::U8 => {
                    let x = b[0] as f32;
                    if norm { x / 255.0 } else { x }
                }
                DataType::I8 => {
                    let x = b[0] as i8 as f32;
                    if norm { (x / 127.0).max(-1.0) } else { x }
                }
                DataType::U16 => {
                    let x = u16::from_le_bytes([b[0], b[1]]) as f32;
                    if norm { x / 65535.0 } else { x }
                }
                DataType::I16 => {
                    let x = i16::from_le_bytes([b[0], b[1]]) as f32;
                    if norm { (x / 32767.0).max(-1.0) } else { x }
                }
                DataType::U32 => u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32,
            };
            out.push(if v.is_finite() { v } else { 0.0 });
        }
    }
    Ok(out)
}

fn read_indices<'a>(a: &gltf::Accessor<'a>, data_of: &dyn Fn(gltf::Buffer<'a>) -> Result<&'a [u8], String>) -> Result<Vec<u32>, String> {
    let (data, first, stride, _, count) = layout(a, data_of)?;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let at = first + i * stride;
        out.push(match a.data_type() {
            DataType::U8 => data[at] as u32,
            DataType::U16 => u16::from_le_bytes([data[at], data[at + 1]]) as u32,
            DataType::U32 => u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]),
            t => return Err(format!("indices of type {t:?}")),
        });
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn pack(json: &str, bin: &[u8]) -> Vec<u8> {
        let mut j = json.as_bytes().to_vec();
        while j.len() % 4 != 0 {
            j.push(b' ');
        }
        let mut bin = bin.to_vec();
        while bin.len() % 4 != 0 {
            bin.push(0);
        }
        let total = 12 + 8 + j.len() + 8 + bin.len();
        let mut out = Vec::new();
        out.extend_from_slice(b"glTF");
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&(total as u32).to_le_bytes());
        out.extend_from_slice(&(j.len() as u32).to_le_bytes());
        out.extend_from_slice(b"JSON");
        out.extend_from_slice(&j);
        out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        out.extend_from_slice(b"BIN\0");
        out.extend_from_slice(&bin);
        out
    }

    /// A minimal GLB: one triangle, int16 normalized positions (KHR_mesh_quantization), a node scale.
    fn glb() -> Vec<u8> {
        let mut bin: Vec<u8> = Vec::new();
        for p in [[0i16, 0, 0, 0], [32767, 0, 0, 0], [0, 32767, 0, 0]] {
            for c in p {
                bin.extend_from_slice(&c.to_le_bytes());
            }
        }
        for i in [0u16, 1, 2, 0] {
            bin.extend_from_slice(&i.to_le_bytes());
        }
        let json = r#"{"asset":{"version":"2.0"},"extensionsUsed":["KHR_mesh_quantization"],"extensionsRequired":["KHR_mesh_quantization"],
"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0,"scale":[2,2,2]}],
"meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],
"buffers":[{"byteLength":32}],"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":24,"byteStride":8},{"buffer":0,"byteOffset":24,"byteLength":6}],
"accessors":[{"bufferView":0,"componentType":5122,"normalized":true,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}]}"#;
        pack(json, &bin)
    }

    /// A skinned GLB: one triangle on a skin of two joints (root at the origin, tip 1 m up), the mesh node moved 0.5 m
    /// along x (baked like GLTFLoader's bind), an emissive `glow_eyes` material, a rigid box under the tip joint.
    pub(crate) fn skinned_glb() -> Vec<u8> {
        let mut bin: Vec<u8> = Vec::new();
        let f = |bin: &mut Vec<u8>, v: &[f32]| v.iter().for_each(|x| bin.extend_from_slice(&x.to_le_bytes()));
        // 0: positions (3 × vec3) at 0
        f(&mut bin, &[0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        // 36: joints (3 × u8x4) at 36
        for j in [[0u8, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0]] {
            bin.extend_from_slice(&j);
        }
        // 48: weights (3 × vec4)
        f(&mut bin, &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0]);
        // 96: inverse bind matrices (2 × mat4): root identity, tip translate(0,-1,0)
        f(&mut bin, &[1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        f(&mut bin, &[1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 1.0]);
        let json = r#"{"asset":{"version":"2.0"},"extensionsUsed":["KHR_materials_emissive_strength"],
"scene":0,"scenes":[{"nodes":[0,1]}],
"nodes":[{"name":"Hips","children":[2]},{"name":"Body","mesh":0,"skin":0,"translation":[0.5,0,0]},{"name":"Head","translation":[0,1,0],"children":[3]},{"name":"helmet","mesh":1,"translation":[0,0.2,0]}],
"skins":[{"joints":[0,2],"inverseBindMatrices":3}],
"materials":[{"name":"glow_eyes","emissiveFactor":[1,0.5,0.25],"extensions":{"KHR_materials_emissive_strength":{"emissiveStrength":2}},"doubleSided":true},{"name":"iron"}],
"meshes":[{"primitives":[{"attributes":{"POSITION":0,"JOINTS_0":1,"WEIGHTS_0":2},"material":0}]},{"primitives":[{"attributes":{"POSITION":0},"material":1}]}],
"buffers":[{"byteLength":224}],
"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":12},{"buffer":0,"byteOffset":48,"byteLength":48},{"buffer":0,"byteOffset":96,"byteLength":128}],
"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[0,1,1]},{"bufferView":1,"componentType":5121,"count":3,"type":"VEC4"},{"bufferView":2,"componentType":5126,"count":3,"type":"VEC4"},{"bufferView":3,"componentType":5126,"count":2,"type":"MAT4"}]}"#;
        pack(json, &bin)
    }

    /// What the art library's Meshy files carry (tracks C2 and C3): a `glow_coals` material whose emissive map is its
    /// base picture, a `player_tint` material named by `gf_body`'s `gfTint`, and a `flash_muzzle` node marked `gfHidden`.
    pub(crate) fn art_glb() -> Vec<u8> {
        let mut bin: Vec<u8> = Vec::new();
        for v in [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0] {
            bin.extend_from_slice(&v.to_le_bytes());
        }
        // 36: a picture's bytes (never decoded here: the host decodes pictures)
        bin.extend_from_slice(&[0x89, b'P', b'N', b'G']);
        let json = r#"{"asset":{"version":"2.0"},"extensionsUsed":["KHR_materials_emissive_strength"],
"scene":0,"scenes":[{"nodes":[0,1,2,3]}],
"nodes":[{"name":"gf_body","extras":{"gfTint":["player_tint"],"gfTintMix":0.9}},{"name":"coals","mesh":0},{"name":"cloak","mesh":1},{"name":"flash_muzzle","mesh":2,"translation":[0,0,5],"extras":{"gfHidden":true}}],
"images":[{"bufferView":1,"mimeType":"image/png"}],"textures":[{"source":0}],
"materials":[{"name":"glow_coals","pbrMetallicRoughness":{"baseColorTexture":{"index":0}},"emissiveFactor":[1,1,1],"emissiveTexture":{"index":0},"extensions":{"KHR_materials_emissive_strength":{"emissiveStrength":2}}},{"name":"player_tint","pbrMetallicRoughness":{"baseColorFactor":[0.1,0.1,0.5,1]}},{"name":"flash_muzzle","emissiveFactor":[1,0.48,0.13],"doubleSided":true}],
"meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]},{"primitives":[{"attributes":{"POSITION":0},"material":1}]},{"primitives":[{"attributes":{"POSITION":0},"material":2}]}],
"buffers":[{"byteLength":40}],"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":4}],
"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}]}"#;
        pack(json, &bin)
    }

    #[test]
    fn reads_emissive_maps_hidden_nodes_and_the_player_tint() {
        let m = parse(&art_glb()).unwrap();
        let by = |name: &str| m.prims.iter().find(|p| p.material == name).unwrap();
        assert!(by("glow_coals").emissive_map && !by("glow_coals").emissive_map_other, "its emissive map is its base picture");
        assert!((by("glow_coals").emissive[0] - 2.0).abs() < 1e-6);
        assert!(!by("player_tint").emissive_map);
        assert_eq!(m.tint, vec!["player_tint".to_string()]);
        assert_eq!(m.tint_mix, Some(0.9));
        assert_eq!(by("flash_muzzle").hidden, m.node_named("flash_muzzle"));
        assert!(by("glow_coals").hidden.is_none());
        // the hidden flash, 5 m out, is not part of the model's box
        assert!(m.max.z < 1.0, "bounds {:?}", m.max);
    }

    #[test]
    fn reads_a_quantized_triangle_with_its_node_scale() {
        let m = parse(&glb()).unwrap();
        assert_eq!(m.prims.len(), 1);
        let p = &m.prims[0];
        assert_eq!(p.mesh.indices, vec![0, 1, 2]);
        assert!((p.mesh.vertices[1].pos[0] - 1.0).abs() < 1e-4);
        assert!((m.max.x - 2.0).abs() < 1e-3 && (m.max.y - 2.0).abs() < 1e-3, "bounds {:?}", m.max);
        // no normals in the file: computed from the face (+Z)
        assert!((p.mesh.vertices[0].normal[2] - 1.0).abs() < 1e-4);
        assert!(p.mesh.skin.is_none() && p.skin.is_none());
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        assert!(parse(b"not a glb").is_err());
        // a required extension it cannot read (same length, so the chunks still line up)
        let mut b = glb();
        let at = b.windows(21).rposition(|w| w == b"KHR_mesh_quantization").unwrap();
        b[at..at + 21].copy_from_slice(b"EXT_meshopt_compressX");
        let e = parse(&b).unwrap_err();
        assert!(e.contains("EXT_meshopt_compressX"), "{e}");
    }

    #[test]
    fn reads_skins_nodes_and_materials() {
        let m = parse(&skinned_glb()).unwrap();
        assert_eq!(m.skins, vec![vec![0, 2]]);
        assert_eq!(m.nodes.len(), 4);
        assert_eq!(m.nodes[3].parent, Some(2));
        assert_eq!(m.node_named("Head"), Some(2));
        let body = m.prims.iter().find(|p| p.skin.is_some()).unwrap();
        // the skinned mesh node's +0.5 m x is ignored, as the glTF spec and three.js ignore it
        assert!(body.mesh.vertices[0].pos[0].abs() < 1e-5);
        assert_eq!(body.local, Mat4::IDENTITY);
        let s = body.mesh.skin.as_ref().unwrap();
        assert_eq!(s[1].joints[0], 1);
        assert!((s[2].weights[0] - 0.5).abs() < 1e-6);
        assert_eq!(body.material, "glow_eyes");
        assert!(body.double_sided);
        assert!((body.emissive[0] - 2.0).abs() < 1e-6 && (body.emissive[1] - 1.0).abs() < 1e-6);
        let helmet = m.prims.iter().find(|p| p.skin.is_none()).unwrap();
        assert_eq!(helmet.node, 3);
        // the helmet hangs 1.2 m up (Hips → Head 1 m → helmet 0.2 m)
        assert!((helmet.local.w_axis.y - 1.2).abs() < 1e-5);
        assert!((m.node_world(3).w_axis.y - 1.2).abs() < 1e-5);
    }
}
