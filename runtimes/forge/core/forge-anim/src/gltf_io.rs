//! Reading a glTF 2.0 binary (GLB) for animation: accessors of any component type (normalized integers, as
//! KHR_mesh_quantization and quantized animation keys use), node matrices, and the scene graph's parents. Content is
//! never compiled in (PLAN §2): bodies and clips arrive as slot files' bytes. EXT_meshopt_compression is decoded by the
//! host (`gf/forge/meshopt.js`) before the bytes get here; sparse accessors and external buffers are refused.
use glam::{Mat4, Quat, Vec3};
use gltf::accessor::{DataType, Dimensions};

pub struct Doc {
    pub g: gltf::Gltf,
}

impl Doc {
    pub fn parse(bytes: &[u8]) -> Result<Doc, String> {
        let g = gltf::Gltf::from_slice_without_validation(bytes).map_err(|e| format!("not a glTF 2.0 binary: {e}"))?;
        for ext in g.extensions_required() {
            if ext != "KHR_mesh_quantization" && ext != "KHR_materials_emissive_strength" {
                return Err(format!("needs {ext}, which gf-forge cannot read (the host decodes EXT_meshopt_compression first)"));
            }
        }
        Ok(Doc { g })
    }

    fn data_of(&self, b: gltf::Buffer) -> Result<&[u8], String> {
        match b.source() {
            gltf::buffer::Source::Bin => self.g.blob.as_deref().ok_or_else(|| "the GLB has no binary chunk".to_string()),
            gltf::buffer::Source::Uri(_) => Err(format!("buffer {} is not inside the .glb", b.index())),
        }
    }

    /// The accessor's elements as floats (`want` components each; normalized integers mapped to 0..1 or −1..1).
    pub fn floats(&self, a: &gltf::Accessor, want: usize) -> Result<Vec<f32>, String> {
        let comps = comps_of(a.dimensions());
        if comps < want {
            return Err(format!("accessor {} has {} components, needs {}", a.index(), comps, want));
        }
        if a.sparse().is_some() {
            return Err(format!("accessor {} is sparse", a.index()));
        }
        let view = a.view().ok_or_else(|| format!("accessor {} has no buffer view", a.index()))?;
        let data = self.data_of(view.buffer())?;
        let t = a.data_type();
        let cs = size_of(t);
        let elem = cs * comps;
        let stride = view.stride().unwrap_or(elem).max(elem);
        let first = view.offset() + a.offset();
        let count = a.count();
        if count > 0 {
            let end = first + stride * (count - 1) + elem;
            if end > view.offset() + view.length() || end > data.len() {
                return Err(format!("accessor {} runs past its buffer view", a.index()));
            }
        }
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

    /// Every node's parent (None for a scene root or an orphan).
    pub fn parents(&self) -> Vec<Option<usize>> {
        let mut p = vec![None; self.g.nodes().count()];
        for n in self.g.nodes() {
            for c in n.children() {
                if c.index() < p.len() {
                    p[c.index()] = Some(n.index());
                }
            }
        }
        p
    }

    /// Every node's matrix in the scene (its parents' transforms applied; a scene's own is identity).
    pub fn world_matrices(&self) -> Vec<Mat4> {
        let n = self.g.nodes().count();
        let parents = self.parents();
        let local: Vec<Mat4> = self.g.nodes().map(|x| Mat4::from_cols_array_2d(&x.transform().matrix())).collect();
        let mut world = vec![None; n];
        fn get(i: usize, parents: &[Option<usize>], local: &[Mat4], world: &mut [Option<Mat4>], depth: usize) -> Mat4 {
            if let Some(m) = world[i] {
                return m;
            }
            let m = match parents[i] {
                Some(p) if depth < 256 => get(p, parents, local, world, depth + 1) * local[i],
                _ => local[i],
            };
            world[i] = Some(m);
            m
        }
        (0..n).map(|i| get(i, &parents, &local, &mut world, 0)).collect()
    }

    /// A node's local translation, rotation and scale.
    pub fn trs(&self, node: usize) -> (Vec3, Quat, Vec3) {
        let n = self.g.nodes().nth(node).expect("a node index from this document");
        let (t, r, s) = n.transform().decomposed();
        (Vec3::from(t), Quat::from_array(r).normalize(), Vec3::from(s))
    }

    /// A node's or the scene's extras, parsed.
    pub fn node_extras(&self, node: usize) -> Option<serde_json::Value> {
        let n = self.g.nodes().nth(node)?;
        n.extras().as_ref().and_then(|r| serde_json::from_str(r.get()).ok())
    }
    pub fn scene_extras(&self) -> Option<serde_json::Value> {
        let s = self.g.default_scene().or_else(|| self.g.scenes().next())?;
        s.extras().as_ref().and_then(|r| serde_json::from_str(r.get()).ok())
    }
}

pub fn comps_of(d: Dimensions) -> usize {
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

pub fn size_of(t: DataType) -> usize {
    match t {
        DataType::I8 | DataType::U8 => 1,
        DataType::I16 | DataType::U16 => 2,
        DataType::U32 | DataType::F32 => 4,
    }
}

/// Build a GLB from a JSON document and its binary chunk (tests and tools).
pub fn glb(json: &str, bin: &[u8]) -> Vec<u8> {
    let mut j = json.as_bytes().to_vec();
    while !j.len().is_multiple_of(4) {
        j.push(b' ');
    }
    let mut b = bin.to_vec();
    while !b.len().is_multiple_of(4) {
        b.push(0);
    }
    let total = 12 + 8 + j.len() + if b.is_empty() { 0 } else { 8 + b.len() };
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(j.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&j);
    if !b.is_empty() {
        out.extend_from_slice(&(b.len() as u32).to_le_bytes());
        out.extend_from_slice(b"BIN\0");
        out.extend_from_slice(&b);
    }
    out
}
