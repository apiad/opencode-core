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
MYUID=$(id -u)
MYGID=$(id -g)

# Default to root group if GID is empty
MYGID="${MYGID:-0}"

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

# Get project name for image detection
PROJECT_NAME=$(basename "$PWD")
SANDBOX_IMAGE="${PROJECT_NAME}-sandbox"

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo "  ⚠️  WARNING: Sandbox is not setup                             "
    echo "                                                                "
    echo "  Docker is not installed or not in PATH.                       "
    echo "  Running command directly without isolation...                 "
    echo "════════════════════════════════════════════════════════════════"
    echo ""
    exec bash -c "$*"
fi

# Check if the sandbox image exists
if ! docker image inspect "$SANDBOX_IMAGE" &> /dev/null; then
    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo "  ⚠️  WARNING: Sandbox is not setup                             "
    echo "                                                                "
    echo "  Docker image '$SANDBOX_IMAGE' not found.                      "
    echo "  Run '/sandbox' and build the sandbox image first.             "
    echo "  Running command directly without isolation...                 "
    echo "════════════════════════════════════════════════════════════════"
    echo ""
    exec bash -c "$*"
fi

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
    --user "$MYUID:$MYGID" \
    --network host \
    -m 2g \
    $PROJECT_MOUNT \
    $PLAYGROUND_MOUNT \
    $KNOWLEDGE_MOUNT \
    -w /project \
    "$SANDBOX_IMAGE" \
    bash -c "$*"
