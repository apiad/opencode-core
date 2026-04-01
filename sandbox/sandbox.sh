#!/bin/bash
# sandbox.sh - Docker wrapper for command isolation
# Usage: sandbox.sh <mode> <command>
# Modes: analyze, design, create

set -e

MODE="${1:-analyze}"
shift

# Get absolute paths
PROJECT_DIR="$(pwd)"
PLAYGROUND_DIR="$PROJECT_DIR/.playground"
KNOWLEDGE_DIR="$PROJECT_DIR/.knowledge"

# Get current user for permission correctness
UID=$(id -u)
GID=$(id -g)

# Default to root group if GID is empty
GID="${GID:-0}"

# Build mounts based on mode
case "$MODE" in
  analyze)
    PROJECT_MOUNT="-v $PROJECT_DIR:/project:ro"
    PLAYGROUND_MOUNT="-v $PLAYGROUND_DIR:/playground:rw"
    KNOWLEDGE_MOUNT="-v $KNOWLEDGE_DIR:/knowledge:rw"
    ;;
  design)
    PROJECT_MOUNT="-v $PROJECT_DIR:/project:ro"
    PLAYGROUND_MOUNT="-v $PLAYGROUND_DIR:/playground:ro"
    KNOWLEDGE_MOUNT="-v $KNOWLEDGE_DIR:/knowledge:rw"
    ;;
  create)
    PROJECT_MOUNT="-v $PROJECT_DIR:/project:rw"
    PLAYGROUND_MOUNT="-v $PLAYGROUND_DIR:/playground:rw"
    KNOWLEDGE_MOUNT="-v $KNOWLEDGE_DIR:/knowledge:rw"
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    echo "Usage: sandbox.sh <analyze|design|create> <command>" >&2
    exit 1
    ;;
esac

# Check if playground exists, create if not
if [ ! -d "$PLAYGROUND_DIR" ]; then
    mkdir -p "$PLAYGROUND_DIR"
fi

# Check if knowledge exists, create if not
if [ ! -d "$KNOWLEDGE_DIR" ]; then
    mkdir -p "$KNOWLEDGE_DIR"
fi

# Run the command in Docker with appropriate mounts
docker run --rm \
    --user "$UID:$GID" \
    --network host \
    -m 2g \
    $PROJECT_MOUNT \
    $PLAYGROUND_MOUNT \
    $KNOWLEDGE_MOUNT \
    -w /project \
    opencode-sandbox \
    bash -c "$@"
