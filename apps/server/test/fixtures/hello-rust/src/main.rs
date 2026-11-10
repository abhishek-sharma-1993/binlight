// Contract fixture for inspect_rust_binary: built with `cargo auditable`, so it
// embeds its crate list. The URL is a test literal for string recipes.
fn main() {
    println!("{} (see https://binlight.invalid/rust)", greeting::greeting());
}
