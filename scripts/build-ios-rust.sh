#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HEADERS="$REPO_DIR/apps/ios/RustHeaders"
VENDOR="$REPO_DIR/apps/ios/Vendor"
OUTPUT="$VENDOR/AgentMeshRust.xcframework"

cd "$REPO_DIR"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-17.0}"
pixi run cargo build --release --lib -p agent-mesh --target aarch64-apple-ios
pixi run cargo build --release --lib -p agent-mesh --target aarch64-apple-ios-sim

mkdir -p "$VENDOR"
rm -rf "$OUTPUT"
xcodebuild -create-xcframework \
  -library "$REPO_DIR/target/aarch64-apple-ios/release/libagent_mesh.a" -headers "$HEADERS" \
  -library "$REPO_DIR/target/aarch64-apple-ios-sim/release/libagent_mesh.a" -headers "$HEADERS" \
  -output "$OUTPUT"
