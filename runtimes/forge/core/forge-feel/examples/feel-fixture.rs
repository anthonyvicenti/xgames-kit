//! The feel fixture runner (forge_feel::fixture says how; scripts in research/gf-forge/fixtures/feel/).
//!
//!   cargo run -p forge-feel --example feel-fixture -- research/gf-forge/fixtures/feel/<name>.json [--trace] [--json]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(forge_feel::fixture::run_main(&args));
}
