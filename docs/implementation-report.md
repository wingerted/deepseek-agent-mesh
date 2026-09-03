# DeepSeek Harness Agent P2P 实现报告

## 结论

当前实现采用“一个 Harness 节点 + 一个 Rust sidecar”的组合。Rust daemon 是网络与数据面唯一所有者；Harness 是 Agent 运行时和策略面。CLI 与模型工具都是同一个 daemon 的客户端，因此不会出现双身份、端口争用或两套成员状态。

```text
Human CLI ─┐
           ├─ loopback RPC + token ─ Rust daemon ─ libp2p ─ peer daemon
Harness Leader ─┘                    │
  local Agent Team / tools           ├─ content store
                                     └─ durable mailbox
```

## 已落地组件

### Rust standalone binary

`agent-mesh daemon` 长期持有 Ed25519 身份和 libp2p Swarm。控制地址与随机令牌写入权限为 0600 的 `control.json`。本机 RPC 支持 `status`、`peers`、`invite.create`、`publish`、`fetch`、`send`、`inbox.list` 和 `inbox.ack`。

P2P 信封分为 `message`、`task`、`task_cancel`、`task_progress`、`task_result`。信封包含网络、发送/接收 Peer ID、UUID、关联 UUID、创建/过期时间、JSON payload 和成员证书。接收端验证网络、传输层 Peer ID、目标、TTL 与根签名成员身份（兼容模式可用 allowlist），持久化成功后才返回 ACK；重复 UUID 幂等。节点声明可带 `dsh-leader/1` 协议、聚合角色、逻辑 workspace、本地 Team 能力与并发上限；teammate 从不作为 Mesh 成员发布。

### CLI 与交付

daemon 管理命令和日常操作位于同一 binary。`status/peers/invite/join/publish/get/message/task/reply/inbox/ack` 读取控制文件连接 daemon。`dsh-mesh up --new` 与 `dsh-mesh join <code>` 把配置、插件安装、Harness Web 和 sidecar 生命周期收束成一个入口。Conda 包同时携带 Rust binary、固定版本 Harness runtime 和两个插件；远端不需要源码 checkout。

### Harness bundle

两个 bundle 位于 `packages/dsh-agent-mesh` 与 `packages/dsh-agent-mesh-web`，没有改动作为外部上游、且可能带有本机未提交修改的 Harness 仓库。

- Service Definition/Provider：`MeshRuntime` 提供 `ctx.mesh.call()`；`MeshLeaderRuntime` 持久保存唯一 Leader Session；sidecar 可由 `ctx.subprocess` 托管或外接。
- 原生委派：`MeshLeaderProvider` 注册到 `ctx.subagents`，`mesh_delegate` 返回远端 `SubagentRun` 代理并沿用 Harness 的 start/end、结果、取消与 dispose 语义。
- Leader 边界：只有绑定的根 Agent 能调用跨节点工具。远端任务只进入该 Leader；它自行调用本机 subagent 或 Agent Team，teammate 对其他节点不可见。
- Inbox activation：每次只激活一个 Leader 任务，用消息 ID 对齐真实 turn；`mesh_task_complete`/`mesh_task_fail` 可显式结算，否则取该 turn 的最后 assistant output。取消既能删除未 claim 的消息，也能中止已开始的 turn。
- 路由：先按协议、role、workspace 过滤，再按私网路径、负载、RTT、出口价格评分。默认 hop budget 为 1，跨过一条 Leader 边后归零，本地 Team 调度不消耗该预算。
- 生命周期：Harness 卸载插件时终止完整 daemon 进程树；真实 Loader 启停已经验证。

## 数据和任务流程

文件流程：发布方导入文件并以 SHA-256 发布 provider；接收方查询新鲜声明和 inventory，依据实际连接路径、双方带宽、RTT、负载和价格选 provider；逐块校验后原子提交并发送 receipt。

任务流程：本地 Leader 调用 `mesh_delegate`；Provider 选择另一个 Leader 并发送 `task`；接收 daemon 先持久化；收件插件把任务放入已经绑定的 Leader Session；远端 Leader 可调度自己的本地 Team；完成后发送 `task_result(correlation_id=task UUID)`，本地 Provider 将其折叠为标准 `SubagentResult`。调用方取消会发送相关联的 `task_cancel`。

## 安全与可靠性

- Noise/QUIC 认证加密连接；Peer ID 来源于稳定公钥。
- 首节点 Ed25519 身份作为 v1 入网根；一次性签名邀请换取绑定 Peer ID 的成员证书。Agent 信封默认要求有效成员证书，静态 allowlist 只保留兼容路径；`network_id` 本身仍不是授权凭据。
- 所有节点都同时提供和使用 libp2p Rendezvous；它只分发地址 hint，不能绕过成员证书。无需第三方发现服务，但全冷启动仍依赖至少一个已知成员在线。
- inbox 是至少一次语义。当前 Leader 消息准入与 inbox ACK 之间仍可能因进程崩溃重复执行，所以任务必须设计为幂等；后续需要 lease、执行 journal 和结果缓存。
- Leader 使用自己 Session 已有的 permission preset；发送方不能提升远端权限。生产部署应为 Mesh Leader 使用专用 preset 和 workspace allowlist。
- 删除需要提供方开关、接收方请求、全块发送证明和整文件哈希回执，且只进入可恢复的 `delete-pending`。

## 验证证据

- Rust 单元测试覆盖选路、非法数值、内容存储、可恢复删除和 mailbox 幂等。
- Node 测试覆盖插件控制客户端鉴权、Leader 能力选路、远端 SubagentRun 结果和取消传播。
- 三 daemon 实测覆盖签名邀请、成员证书、bootstrap、经 rendezvous 发现非 bootstrap Leader、私网路由、RTT、消息/任务/取消落盘 ACK 和内容传输。
- Harness 真实 profile 安装、Loader 加载、托管 daemon 连接以及 Harness 退出后的进程树回收均已执行。
- 从本地 Conda channel 创建全新环境后，实际执行过插件安装、Harness Web 启动、认证快照、sidecar 状态读取和完整退出回收。

## 后续阶段

生产化的下一顺序应是：成员吊销/续期与根轮换 → 持久执行 lease/幂等结果缓存 → Leader task progress 与恢复 → 断点续传与并行窗口 → 对象 ACL/配额/审计 → AutoNAT/DCUtR/Relay → US3/S3 adapter 与账单对账 → 多签治理、信誉和结算。Agent Team 永远留在节点内部；跨节点只稳定 Leader 联邦协议，不暴露 Harness 内部 Agent 对象。
