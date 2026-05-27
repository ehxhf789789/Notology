FROM rust:1.82-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/notology-relay /usr/local/bin/
ENV RELAY_PORT=9399
EXPOSE 9399
CMD ["notology-relay"]
