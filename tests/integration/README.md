# Integration tests

The executable two-node smoke test lives in `scripts/smoke-two-nodes.sh` and is
run through `pixi run test-integration`. It starts two isolated daemons and
verifies discovery, messaging, task cancellation, and content transfer.
