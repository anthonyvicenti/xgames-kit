//! The AI fixture runner (forge_ai::fixture says how; scripts in research/gf-forge/fixtures/ai/).
//!
//!   cargo run --release -p forge-ai --example ai-fixture -- research/gf-forge/fixtures/ai/<name>.json [--trace] [--json]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(forge_ai::fixture::run_main(&args));
}
