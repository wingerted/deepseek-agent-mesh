# Agent Mesh

`agent-mesh` 是一个由单一 Pixi workspace 管理的 Agent P2P monorepo。它同时交付独立 Rust binary、DeepSeek Harness Leader 插件、Harness Web 状态/拓扑插件，以及二者共享的本地 RPC client。

网络模型是 Leader 联邦：每个节点的 DeepSeek Harness 根 Agent 是一个 Leader，Leader 自己管理本机 subagent 或 Agent Team；跨节点只发生 Leader-to-Leader 通信和任务委派。

## Monorepo

```text
crates/agent-mesh/              Rust CLI、daemon、libp2p 与内容传输
packages/mesh-rpc/             daemon 回环控制协议的 Node client
packages/dsh-agent-mesh/        Harness Leader、工具、inbox 与主动调度
packages/dsh-agent-mesh-web/    Harness Web 状态、meta 与拓扑
spec/                          本地 RPC 和 P2P wire 协议版本说明
configs/examples/              本机及 WireGuard 配置示例
tooling/                       Harness profile 与发布编排
tests/                         跨组件集成测试入口
```

DeepSeek Harness 核心源码不属于本仓库。开发集成默认使用兄弟目录 `../deepseek-harness`，兼容版本记录在 `compat/harness.json`。

## 环境、构建与验证

Pixi 固定 Rust、Node.js 24、pnpm 11.7、Git、jq 和 ripgrep；Cargo 与 pnpm 分别管理各自生态的库依赖。`iperf3` 在当前 conda-forge `osx-arm64` 渠道没有可用包，因此保留为可选系统诊断工具，不进入可复现环境。

```bash
cd /Users/wingerted/Developer/agent-mesh
pixi install
pixi run bootstrap
pixi run build
pixi run test
pixi run check
```

常用细分任务：

```bash
pixi run test-rust
pixi run test-plugins
pixi run test-integration
pixi run pack
```

生产运行只需要 `target/release/agent-mesh`，开发与运行链路都由 Pixi、Cargo 和 pnpm 管理。

## 独立 CLI

第一台节点：

```bash
target/release/agent-mesh \
  --state-dir ./node-a \
  --identity ./node-a/identity.key \
  --store ./node-a/store \
  --network-id team-a \
  --name shanghai-egress \
  --listen /ip4/0.0.0.0/tcp/41001 \
  --private-network vpc-prod \
  --allow-peer <PEER_B> \
  daemon
```

另一个节点使用启动日志中的完整 multiaddr 作为 bootstrap：

```bash
target/release/agent-mesh \
  --state-dir ./node-b \
  --identity ./node-b/identity.key \
  --store ./node-b/store \
  --network-id team-a \
  --name consumer \
  --bootstrap /ip4/10.0.0.8/tcp/41001/p2p/<PEER_A> \
  --allow-peer <PEER_A> \
  daemon
```

控制正在运行的 daemon：

```bash
target/release/agent-mesh --state-dir ./node-a status
target/release/agent-mesh --state-dir ./node-a peers
target/release/agent-mesh --state-dir ./node-a publish ./large-file.bin
target/release/agent-mesh --state-dir ./node-b get <SHA256> --output ./received.bin --max-cost 0
```

## DeepSeek Harness 开发

复制一份本机配置；`*.local.toml` 不进入版本库：

```bash
cp configs/examples/local.toml configs/local.toml
```

然后由 monorepo 构建并安装两个插件到隔离的 Harness profile：

```bash
pixi run harness-install
pixi run harness-dump
pixi run harness-web
```

`DSH_REPO` 可覆盖 Harness checkout，`DSH_HOME` 可覆盖隔离 profile 根目录。WireGuard 开发可复制 `configs/examples/wireguard.toml`，修改地址后通过以下方式启动：

```bash
pixi run harness-web -- --config configs/wireguard.local.toml
```

配置中的 `ingress_mbps` 和 `egress_mbps` 是用于选路的运营者声明，不是测速结果；Web 页面明确显示为“配置带宽”。真实值应在节点间用 `iperf3` 双向测量后填写。

插件说明见 [Harness 插件](packages/dsh-agent-mesh/README.md) 与 [Web 插件](packages/dsh-agent-mesh-web/README.md)。协议与安全边界见 [P2P 设计](docs/p2p-design.md) 和 [实现报告](docs/implementation-report.md)。

## 当前安全边界

- 空 allowlist 默认拒绝 Agent 消息与任务；`allow_all_peers` 仅适合受控开发网络。
- daemon token、Peer identity、mailbox、对象仓库与本机配置不进入 Git。
- Web 快照是 Harness 认证后的同源只读接口，不返回 daemon token。
- 校验后源端清理只移动到 `delete-pending`，不会立即物理删除。
- 内容 ACL、组织证书、配额、信誉、结算、AutoNAT/DCUtR/Circuit Relay 与断点续传仍未实现。
