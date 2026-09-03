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
packaging/conda/               单包交付 Rust、Harness 与两个插件
tests/                         跨组件集成测试入口
```

DeepSeek Harness 核心源码不属于本仓库。开发集成默认使用兄弟目录 `../deepseek-harness`，兼容版本记录在 `compat/harness.json`。

## 环境、构建与验证

Pixi 固定 Rust、Node.js 24、pnpm 11.7、Git、jq 和 ripgrep；Cargo 与 pnpm 分别管理各自生态的库依赖。`iperf3` 在当前 conda-forge `osx-arm64` 渠道没有可用包，因此保留为可选系统诊断工具，不进入可复现环境。

```bash
cd agent-mesh
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

开发链路由 Pixi、Cargo 和 pnpm 管理；远端节点推荐安装 Conda 包，不需要 checkout 本仓库或 DeepSeek Harness。

## 最简安装与组网

发布方先构建 channel（当前机器会产生 `osx-arm64` 包）：

```bash
pixi run package-conda
```

将 `artifacts/conda/` 原样同步到一个 HTTPS 静态目录即可成为 Conda channel；目录中的平台子目录和 `repodata.json` 必须保留。Linux 包应在 Linux CI 上另行构建。远端安装命令为：

```bash
pixi global install \
  --channel https://downloads.example.com/agent-mesh \
  --channel conda-forge \
  agent-mesh
```

第一台 Leader 在 WireGuard 地址上创建网络并启动；终端会打印 Harness Web URL 和一枚 15 分钟、单次使用的 `mesh1:` 邀请码：

```bash
dsh-mesh up --new --bind 10.200.0.1 --name shanghai-leader
```

第二台机器安装同一个包后，只需粘贴邀请码。`join` 会验证创始节点签名、推断到 bootstrap 的本机源地址、领取成员证书、安装两个 Harness 插件并立即启动：

```bash
dsh-mesh join 'mesh1:...' --name beijing-leader
```

路由推断不符合预期时显式指定 WireGuard 地址：

```bash
dsh-mesh join 'mesh1:...' --bind 10.200.0.2
```

后续重启、生成另一枚邀请和查看节点分别使用：

```bash
dsh-mesh up
dsh-mesh invite --ttl 900
dsh-mesh status
dsh-mesh peers
```

默认状态在 `~/.dsh/agent-mesh`，Harness profile 在 `~/.dsh/profiles/web`。设置 `DSH_HOME` 可整体隔离。Mesh 默认监听所选地址的 TCP/UDP 41001，Harness Web 默认监听相同地址的 TCP 8787；防火墙和 WireGuard ACL 需要放行这些端口。

这里的 rendezvous 不是第三方 SaaS：每个 `agent-mesh` 节点都内置 libp2p Rendezvous server。邀请码里的创始节点地址只是初始会合 hint；节点加入后会在网络命名空间登记并从成员节点发现其他 Leader。创始节点离线后，已经互相发现并保持地址的节点仍可直连；全冷启动时仍需至少一个已知成员可达。

邀请码是 bearer secret，虽然有签名、有效期且只能兑换一次，但使用前仍应按密码处理。它是“一条可粘贴字符串”，不是需要外部短码解析服务的人类短码。

## 独立底层 CLI

`dsh-mesh` 是推荐入口；调试协议和内容面时可以直接调用同包内的 Rust binary：

```bash
agent-mesh --state-dir ~/.dsh/agent-mesh status
agent-mesh --state-dir ~/.dsh/agent-mesh peers
agent-mesh --state-dir ~/.dsh/agent-mesh publish ./large-file.bin
agent-mesh --state-dir ~/.dsh/agent-mesh get <SHA256> --output ./received.bin --max-cost 0
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

- 新网络由创始 Peer 的 Ed25519 根身份签发一次性邀请和成员证书；传输时仍由 libp2p Noise/QUIC 认证加密。
- 邀请 secret 仅以 SHA-256 摘要落盘；成员证书绑定 network、Peer ID、签发者和有效期。
- v1 只有创始节点能签发邀请，成员证书有效期为一年，尚无吊销与续期协议。运行数据面是去中心化的，但入网治理当前是单根模型。
- 没有成员证书时，空 allowlist 仍默认拒绝 Agent 消息与任务；`allow_all_peers` 仅适合受控开发网络和兼容调试。
- daemon token、Peer identity、mailbox、对象仓库与本机配置不进入 Git。
- Web 快照是 Harness 认证后的同源只读接口，不返回 daemon token。
- 校验后源端清理只移动到 `delete-pending`，不会立即物理删除。
- 内容 ACL、成员吊销/轮换、配额、信誉、结算、AutoNAT/DCUtR/Circuit Relay 与断点续传仍未实现。
