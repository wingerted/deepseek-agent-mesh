# iOS Mesh Watcher：产品与交互设计

## 产品边界

iOS App 是加入 Agent Mesh 的独立 Watcher 节点。它拥有自己的 P2P 身份、成员证书和持久 inbox，广告 `node_role: watcher` 和 `leader: null`，但不运行 DeepSeek Harness。它负责观察与协调；每个 Harness Leader 仍独立管理自己的 Session 和 Agent Team。

这条边界决定了界面里不会出现“在 iPhone 上执行”或“加入远端 Agent Team”：

- 消息：传给一个或多个 Leader 的当前 Leader Session；
- 任务：传给一个 Leader，由该 Leader 自己选择已绑定且空闲的 Session，再管理其本地 Agent Team；
- 结果：通过 `correlation_id` 返回 Watcher，更新原任务，不创建一条无法关联的孤立通知。

## 信息架构

| 入口 | 首要问题 | 关键操作 |
| --- | --- | --- |
| 总览 | 网络健康吗，有什么需要我处理？ | 发消息、派任务、刷新、进入最近动态 |
| Leader | 哪些 Harness Leader 可用，哪一个最合适？ | 搜索、查看能力、单点消息或任务 |
| 动态 | 消息是否送达，任务是否完成？ | 按消息/任务过滤、查看结果和逐节点回执 |
| 设置 | 我以什么身份加入哪个网络？ | 首次加入、断开、复制 Peer ID、清理本地历史 |

总览只展示决策所需信息：在线 Leader 数、进行中任务、未读结果、按 RTT 排序的拓扑摘要和最近动态。原始 Peer ID、workspace、并行度与 Agent Team 能力下沉到 Leader 详情。

## 核心流程

### 首次加入

1. 用户从已有成员取得限时 `mesh1h:` 邀请 hint；
2. 在设置中确认设备名和 Network ID，粘贴邀请；
3. 启动成功后清空输入框，将签名 membership 留在 App 沙盒；
4. 后续启动自动重连。失败时保留邀请码并显示 Rust 返回的具体原因。

### 发消息与广播

Composer 默认清楚展示接收者。单点消息可直接发送；选择“所有在线 Leader”时，发送前显示当前接收者数量并二次确认。实现上对每个 Leader 独立发送，因此动态详情能展示逐节点的已送达或失败状态，而不是用一个模糊的“广播成功”。

`已送达` 表示远端 Mesh daemon 已持久接收 envelope。它不等于人或模型已经阅读消息。

### 派发任务

任务只能选择一个 Leader，避免广播导致不可控的重复执行。任务 envelope 与 Harness 插件现有 `dsh-leader/1` 兼容；详情依次显示发送中、已送达、执行中、已完成或失败。返回的文本和 diagnostic 保存在原任务详情中。

## 状态与异常

- Offline：没有本地 Rust 节点；操作按钮禁用并引导到设置。
- Online / 无 Leader：Watcher 正常，但尚未发现声明 `dsh-leader/1` 的 peer；界面建议检查 WireGuard、bootstrap 和远端进程。
- Online / 有 Leader：允许消息和任务。
- 部分广播失败：整条动态标记失败，同时保留每个接收者的独立状态，方便定点重试（重试动作留给下一迭代）。
- App 进入后台：不伪装成持续在线服务；回到前台后继续拉取持久 inbox。

## 可用性约束

- 颜色之外始终有文字或图标表达状态；
- 支持 Dynamic Type、深色模式、VoiceOver 合并标签与不少于 44pt 的主要触控目标；
- 高风险范围操作（全 Leader 广播、清理本地历史）需要明确确认；
- 列表以 RTT 排序，但不把 RTT 等同于执行能力；角色、负载、workspace 和并行度在详情中共同呈现；
- 历史最多保留最近 500 条，并以原子写入持久化。

## 后续迭代

1. 为部分失败的广播增加只重试失败接收者；
2. 支持 Leader 对 Watcher 消息的显式已读/回复回执；
3. 将拓扑摘要升级为按 region、route 与 relay 分组的可缩放图；
4. 增加本地通知，在 App 恢复或获得合法推送唤醒后提示任务结果；
5. 为常用任务加入模板，但仍在发送前展示完整 prompt 与目标 Leader。
