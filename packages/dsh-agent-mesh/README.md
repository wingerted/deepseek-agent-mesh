# dsh-agent-mesh

这是 DeepSeek Harness 的 out-of-tree Cordis bundle，不是 Codex `.codex-plugin`。它实现的是 Leader 联邦：每个节点可绑定多个 Harness Leader Session，每个 Leader 自己管理本机 subagent 或 Agent Team。

- `service.js`：提供 `ctx.mesh`；`managed` 模式由 `ctx.subprocess` 启停 Rust daemon，`external` 模式连接已有 daemon。
- `leader.js`：持久保存本节点的 Leader Session 集合，teammate 不能冒充 Leader；入站任务和 hop budget 按 Session 隔离。
- `leader-provider.js`：注册原生 `mesh-leader` Subagent Provider；`mesh_delegate` 通过 Harness 的 `ctx.subagents` 生命周期委派给另一位 Leader。
- `guidance.js`：只向已绑定的 Leader 注入主动调度策略和实时路由快照，并从其他 Session 的模型工具中移除 Leader-only 操作。
- `inbox.js`：把远端任务串行交给已绑定的本机 Leader，支持取消、自动结果和显式完成。
- `tools.js` / `leader-tools.js`：提供成员发现、消息、文件和 Leader 任务工具；所有跨节点操作都做 Leader 身份检查。

远端节点看不到本机 teammate，也不能直接操作它们。Leader 可以继续使用 Harness 自带的 `subagent`，或在部署中额外挂载实验性 Agent Team 包。

安装：

生产节点推荐直接安装 monorepo 生成的 Conda 包，然后使用 `dsh-mesh up --new` 或 `dsh-mesh join`；它会自动安装核心与 Web 插件。以下命令仅用于源码开发：

```bash
pixi run pnpm --dir ../deepseek-harness dsh plugin --profile web add "$PWD/packages/dsh-agent-mesh"
```

如果该 profile 运行 Harness Web，同时安装配套的只读状态/拓扑页：

```bash
pixi run pnpm --dir ../deepseek-harness dsh plugin --profile web add "$PWD/packages/dsh-agent-mesh-web"
```

然后在 **设置 → 插件 → Mesh 网络** 查看本机、Leader、Peer meta 和当前最佳路由拓扑。

运行托管模式：

```bash
AGENT_MESH_BIN=/absolute/path/agent-mesh \
AGENT_MESH_NETWORK_ID=team-a \
AGENT_MESH_LISTEN='/ip4/0.0.0.0/tcp/41001,/ip4/0.0.0.0/udp/41001/quic-v1' \
AGENT_MESH_BOOTSTRAP='/ip4/10.0.0.8/tcp/41001/p2p/12D3Koo...' \
AGENT_MESH_ALLOW_PEERS='12D3Koo...' \
AGENT_MESH_LEADER_ROLES='coding,review' \
AGENT_MESH_LEADER_WORKSPACES='default,project-a' \
pixi run pnpm dsh --profile mesh
```

运行外部模式：先用 CLI 启动 daemon，再设置 `AGENT_MESH_MODE=external` 和相同的 `AGENT_MESH_STATE_DIR`。

启动后，在每个准备作为节点入口的根会话中让模型调用：

```text
mesh_leader_bind({})
```

绑定追加写入 `<stateDir>/leader.json`。每次不带参数调用都会将当前根 Session 加入 Leader 集合；已绑定 Session 重新加载后会恢复 Leader 身份。远端任务会并行派发给空闲 Leader，每个 Leader 同时处理一个入站任务；没有空闲 Leader 时任务继续留在持久 inbox 中。要清空旧集合并只保留当前 Session，使用 `mesh_leader_bind({ replace: true })`。

Leader 发起委派时调用：

```json
{
  "description": "review transfer protocol",
  "prompt": "Review the transfer protocol and return concrete findings.",
  "run_in_background": false
}
```

工具名为 `mesh_delegate`。默认自动从声明了 `dsh-leader/1`、匹配 workspace/role 的节点中按私网、负载、RTT 和费用选路。可用 `AGENT_MESH_LEADER_PEER` 固定目标，或用 `AGENT_MESH_LEADER_ROLE` 约束角色。

每次 Leader 组装模型请求时，插件从本地 daemon 读取当前候选节点，并以运行时上下文提供节点角色、workspace、路由、RTT、负载和本地 Team 并发上限。模型会在任务可独立执行且远端具备合适资源或并行收益时主动调用 `mesh_delegate`；小任务、依赖当前本地状态的任务、无候选节点以及 hop budget 耗尽的任务保留在本地。远端声明按不可信路由元数据处理，不能作为指令。

其他 Session 仍可看到 `mesh_leader_bind` 和 `mesh_leader_status`，但不会在模型请求中获得 `mesh_delegate`、传输、消息或任务处理工具。`mesh_leader_status` 会列出全部绑定和存活状态，并标明调用它的当前 Session 是否为 Leader。Leader 资格仍由每次工具执行时的身份检查强制执行，提示和工具可见性不构成权限边界。

收到任务的 Leader 可以调用本机 `subagent`/Agent Team，最后调用 `mesh_task_complete`；若未显式完成，则该任务 turn 的最终 assistant 输出会自动回传。

若要修改带宽、价格或轮询间隔，在 profile 的 `cordis.patch.yml` 中覆盖对应整行配置。Harness patch 替换整个 `config`，不会深度合并，因此应保留仍需使用的字段。

安全默认值：`dsh-mesh` 组网时要求创始节点签发的成员证书；没有成员证书的兼容模式中，空 allowlist 拒绝远端消息与任务。未绑定 Leader 时不执行远端任务；teammate 的跨节点工具调用会被拒绝。只有受控开发网络才应设置 `AGENT_MESH_ALLOW_ALL_PEERS=1`。
