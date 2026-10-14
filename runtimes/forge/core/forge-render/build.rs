//! The WebGL2 build's shaders (wave 3, track W; Cargo feature `naga-ir`): each shader module's WGSL is parsed and
//! validated here, on the build machine, and written as naga's IR (bincode) into OUT_DIR for src/gpu.rs to include.
//! wgpu's GL backend then needs only naga's validator and GLSL writer in the wasm: no WGSL parser. A shader that does
//! not parse or validate fails the build with naga's own message. With the default feature (`wgsl`: the WebGPU build,
//! the native tests) this script writes nothing: the WGSL text itself is compiled in, and the browser reads it.
//!
//! The same sources in the same order as src/gpu.rs `shader_src` (a native test holds the two together).

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/shaders");
    #[cfg(feature = "naga-ir")]
    ir::write();
}

#[cfg(feature = "naga-ir")]
mod ir {
    use std::path::Path;

    /// (module, the files it is made of, in order): src/gpu.rs `shader_src`.
    const MODULES: [(&str, &[&str]); 4] = [("mesh", &["common", "mesh"]), ("sky", &["common", "sky"]), ("particles", &["common", "particles"]), ("post", &["post"])];

    pub fn write() {
        let dir = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("src/shaders");
        let out = std::env::var("OUT_DIR").unwrap();
        for (name, files) in MODULES {
            let src = files.iter().map(|f| std::fs::read_to_string(dir.join(format!("{f}.wgsl"))).unwrap_or_else(|e| panic!("{f}.wgsl: {e}"))).collect::<Vec<_>>().join("\n");
            let module = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{name}.wgsl: {}", e.emit_to_string(&src)));
            naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::default()).validate(&module).unwrap_or_else(|e| panic!("{name}.wgsl does not validate: {e:?}"));
            let bytes = bincode::serialize(&module).unwrap_or_else(|e| panic!("{name}.wgsl: its IR did not serialize: {e}"));
            std::fs::write(Path::new(&out).join(format!("{name}.naga")), bytes).unwrap();
        }
    }
}
