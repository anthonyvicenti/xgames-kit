//! The native fixture runner: scripted input through the core, headless (forge_core::fixture says how).
//!
//!   cargo run -p forge-core --example fixture -- research/gf-forge/fixtures/core/walk.json [--trace] [--json]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(forge_core::fixture::run_main(&args, |_| {}));
}
