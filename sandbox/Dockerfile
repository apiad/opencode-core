# OpenCode Sandbox - Base Image
# This is a starting point. Agents can customize with /sandbox-setup or manually.
#
# To add specific toolchains, use COPY --from= to pull from official images:
#
#   # Python (with uv)
#   COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
#
#   # Node.js
#   COPY --from=node:20-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
#   COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
#   COPY --from=node:20-slim /usr/local/bin/npm /usr/local/bin/npm
#
#   # Rust
#   COPY --from=rust:1.77-slim /rustup /rustup
#   COPY --from=rust:1.77-slim /usr/local/cargo /usr/local/cargo
#   ENV RUSTUP_HOME=/rustup
#   ENV CARGO_HOME=/usr/local/cargo
#   ENV PATH="/usr/local/cargo/bin:$PATH"
#
#   # Go
#   COPY --from=golang:1.22 /usr/local/go /usr/local/go
#   ENV PATH="/usr/local/go/bin:$PATH"
#
# Or install with apt:
#   RUN apt-get update && apt-get install -y python3 python3-pip nodejs npm
#
# See /sandbox-setup for automatic dependency detection.

FROM ubuntu:24.04

# System tools and utilities
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    bash \
    coreutils \
    findutils \
    grep \
    sed \
    awk \
    make \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /project
