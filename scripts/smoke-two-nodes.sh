#!/usr/bin/env bash
set -euo pipefail

mesh_bin="${1:-target/debug/agent-mesh}"
case "$mesh_bin" in
  /*) ;;
  *) mesh_bin="$PWD/$mesh_bin" ;;
esac
test -x "$mesh_bin"

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-smoke.XXXXXX")"
pid_a=''
pid_b=''
cleanup() {
  test -z "$pid_b" || kill "$pid_b" 2>/dev/null || true
  test -z "$pid_a" || kill "$pid_a" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"$mesh_bin" --state-dir "$smoke_root/a" --identity "$smoke_root/a/id" \
  --store "$smoke_root/a/store" --network-id smoke --name a --allow-all-peers \
  --private-network loopback --leader-protocol dsh-leader/1 --leader-role review \
  --leader-workspace default --leader-team-enabled daemon >"$smoke_root/a.log" 2>&1 &
pid_a=$!

for _ in $(seq 1 100); do
  test -f "$smoke_root/a/control.json" && break
  sleep 0.05
done
status_a="$($mesh_bin --state-dir "$smoke_root/a" status)"
bootstrap="$(printf '%s' "$status_a" | jq -er 'first(.listen_addresses[] | select(contains("/tcp/") and contains("/ip4/127.0.0.1/")))')"
peer_a="$(printf '%s' "$status_a" | jq -er '.peer_id')"

"$mesh_bin" --state-dir "$smoke_root/b" --identity "$smoke_root/b/id" \
  --store "$smoke_root/b/store" --network-id smoke --name b --allow-all-peers \
  --private-network loopback --leader-protocol dsh-leader/1 --leader-role coding \
  --leader-workspace default --leader-team-enabled --bootstrap "$bootstrap" daemon >"$smoke_root/b.log" 2>&1 &
pid_b=$!
for _ in $(seq 1 100); do
  test -f "$smoke_root/b/control.json" && break
  sleep 0.05
done
sleep 1

"$mesh_bin" --state-dir "$smoke_root/b" peers | jq -e \
  'any(.[]; ((.advertisement.capabilities.leader.protocols // []) | index("dsh-leader/1")) != null)' >/dev/null

"$mesh_bin" --state-dir "$smoke_root/b" message "$peer_a" 'mesh-smoke-message' >/dev/null
"$mesh_bin" --state-dir "$smoke_root/a" inbox | jq -e \
  'any(.[]; .payload.text == "mesh-smoke-message")' >/dev/null

task="$($mesh_bin --state-dir "$smoke_root/b" task "$peer_a" 'mesh-smoke-task')"
task_id="$(printf '%s' "$task" | jq -er '.id')"
"$mesh_bin" --state-dir "$smoke_root/b" cancel "$peer_a" "$task_id" >/dev/null
"$mesh_bin" --state-dir "$smoke_root/a" inbox | jq -e --arg task "$task_id" \
  '(any(.[]; .id == $task and .kind == "task")) and (any(.[]; .correlation_id == $task and .kind == "task_cancel"))' >/dev/null

printf 'verified mesh file transfer\n' >"$smoke_root/source.txt"
published="$($mesh_bin --state-dir "$smoke_root/a" publish "$smoke_root/source.txt")"
object_id="$(printf '%s' "$published" | jq -er '.object_id')"
"$mesh_bin" --state-dir "$smoke_root/b" get "$object_id" --output "$smoke_root/received.txt" \
  --max-cost 0 --discovery-seconds 2 >/dev/null
cmp "$smoke_root/source.txt" "$smoke_root/received.txt"

printf 'two-node smoke passed: peer=%s object=%s\n' "$peer_a" "$object_id"
