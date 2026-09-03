#!/usr/bin/env bash
set -euo pipefail

cargo build --workspace --release --locked
pnpm install --frozen-lockfile
pnpm -r --if-present build

install -d "$PREFIX/bin" "$PREFIX/libexec/agent-mesh/plugins"
find target -type f -path '*/release/agent-mesh' -perm -111 \
  -exec install -m 0755 {} "$PREFIX/bin/agent-mesh" \;
test -x "$PREFIX/bin/agent-mesh"
install -m 0755 tooling/dsh-mesh.mjs "$PREFIX/bin/dsh-mesh"
install -m 0644 LICENSE "$PREFIX/libexec/agent-mesh/LICENSE"

runtime="$PREFIX/libexec/agent-mesh"
npm install --prefix "$runtime" --omit=dev --no-audit --no-fund \
  "@deepseek-ai/dsh@0.1.2-alpha.4"

core="$runtime/plugins/dsh-agent-mesh"
install -d "$core/lib"
install -m 0644 packages/dsh-agent-mesh/*.js "$core/"
install -m 0644 packages/dsh-agent-mesh/lib/*.js "$core/lib/"
install -m 0644 packages/dsh-agent-mesh/package.json "$core/package.json"
install -m 0644 packages/dsh-agent-mesh/cordis.patch.yml "$core/cordis.patch.yml"
install -m 0644 packages/dsh-agent-mesh/README.md "$core/README.md"

web="$runtime/plugins/dsh-agent-mesh-web"
install -d "$web/lib"
install -m 0644 packages/dsh-agent-mesh-web/index.js "$web/index.js"
install -m 0644 packages/dsh-agent-mesh-web/lib/client.js "$web/lib/client.js"
install -m 0644 packages/dsh-agent-mesh-web/package.json "$web/package.json"
install -m 0644 packages/dsh-agent-mesh-web/cordis.patch.yml "$web/cordis.patch.yml"
install -m 0644 packages/dsh-agent-mesh-web/README.md "$web/README.md"
