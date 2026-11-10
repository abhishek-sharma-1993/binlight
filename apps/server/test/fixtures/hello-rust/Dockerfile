# Builds the Rust contract fixture with cargo-auditable. The image is built once
# (needs the network for cargo-auditable); fixture builds run with --network none.
FROM rust:1.99.1-slim-bookworm
RUN cargo install cargo-auditable --version 0.7.7 --locked && cargo auditable --version
