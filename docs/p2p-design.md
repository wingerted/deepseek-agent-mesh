# Agent P2P 资源网络设计

## 1. 目标与边界

每个成员都是长期运行的 agent，也是潜在的资源提供方和消费者。网络不依赖一个保存全量成员与对象位置的中央控制面，而是让成员声明能力、发现内容持有者，并依据真实网络路径和本地策略选择传输方式。

这里的“去中心化”限于发现、选路和数据传输。身份授权、商业结算、云账单与争议仲裁不能仅靠 P2P 自动获得可信性。

核心原则：

1. 数据按内容而不是机器名寻址，SHA-256 相同即表示相同对象。
2. 控制消息小而有时效，数据分块传输并可逐块切换 provider。
3. 预算是硬约束，性能是预算内的优化目标。
4. 实测路径优先于节点自报信息，自报能力只能作为提示。
5. 删除是独立、可恢复、双方显式同意的操作，不是下载请求的副作用。

## 2. 协议分层

```text
应用策略       成本/速度/均衡优化，预算约束，删除策略
数据协议       GetInventory / GetChunk / TransferReceipt / DeliverEnvelope（CBOR）
内容发现       Kademlia: (network_id, object_sha256) -> provider PeerId
成员传播       Gossipsub: 有 TTL 的 AgentAdvertisement
邻居发现       mDNS（局域网） + bootstrap multiaddr（跨网入口）
地址交换       Identify；学到的地址显式加入 Kademlia
安全传输       Ed25519 PeerId + Noise + TCP/Yamux 或 QUIC
```

Gossipsub 不被当作节点发现数据库；它负责把短期状态传播给已经形成的 mesh。Kademlia 负责按内容哈希查 provider，mDNS 和 bootstrap 负责获得最初的邻居。

## 3. 身份、网络与声明

首次启动生成 Ed25519 私钥并以 `0600` 权限保存。Peer ID 从公钥派生，因此重启后身份稳定。连接由 Noise 认证和加密，Gossipsub 消息使用节点密钥签名。

`AgentAdvertisement` 包含：

```text
network_id, peer_id, agent_name, sequence
issued_at, expires_at, listen_addresses
region, zone, currency
private_networks, storage_free_bytes
ingress_mbps, egress_mbps, load
idle_price_per_gib, busy_price_per_gib
idle_start_hour, idle_end_hour, utc_offset_minutes
relay
```

- TTL 当前是 90 秒，每 30 秒刷新；过期声明不参与计划。
- `network_id` 同时进入 Gossipsub topic 和 Kademlia provider key，防止不同逻辑网络互相污染。它不是 secret，也不提供授权。
- 货币不同的报价不能直接比较，因此当前只在 `currency` 相等时选择候选。
- 所有浮点声明必须有限，负价格、非法负载和非法带宽会被拒绝。
- `private_networks` 是非秘密标签。只有连接的实际远端地址属于私网/回环，并且标签相交，才判定为免费私网路径。

签名只能证明“这条声明来自这个 Peer ID 且传输中未被修改”，不能证明节点真的有相应带宽、存储或低价出口，也不能防止 Sybil 身份。Agent 消息与任务当前采用显式 Peer allowlist；受控部署仍应进一步把 Peer ID 绑定到组织证书。

daemon 是 Peer ID 和 Swarm 的唯一所有者。本机 CLI 与 Harness 插件通过 `control.json` 中的回环地址和随机令牌调用它；该文件权限为 `0600`。这条本地 RPC 不暴露到局域网或公网。

## 4. 加入与发现流程

```text
启动
  ├─ 加载稳定 Peer ID
  ├─ TCP/QUIC 监听
  ├─ mDNS 寻找同一局域网节点
  └─ 连接一个或多个 bootstrap 地址
          ↓
Identify 交换监听地址，并写入 Kademlia 路由表
          ↓
Gossipsub 发布/接收短期资源声明
          ↓
本地对象以 namespaced SHA-256 key 发布 provider record
          ↓
消费者按对象 key 查 provider，并向候选点对点查询最新声明和库存
```

Bootstrap 是普通成员而不是权威注册中心，可以配置多个并由任何组织运行。失去全部 bootstrap 后，已经互联的网络仍可工作；一个完全孤立的新节点仍需要至少一个入口或同网段 mDNS 邻居。

Kademlia 记录可能滞后，因此“DHT 说某节点有文件”不是最终事实。消费者还会请求实时 inventory；传输中每块及整对象都会重新校验。

## 5. 路径分类与计划

连接分三类：

1. `DirectPrivate`：实际远端 IP 是私网/回环/链路本地，且双方声明同一私网标签。
2. `DirectPublic`：直接公网连接，或虽然地址是私网但双方标签不能确认同一计费域。
3. `Relayed`：multiaddr 含 `p2p-circuit`。当前只识别和保守加价，尚未提供真实 relay transport。

对大小为 `B` 的对象：

```text
size_gib = B / 1024^3
egress_cost = 0                                      (DirectPrivate)
egress_cost = size_gib × provider_window_price      (DirectPublic/Relayed)
relay_cost = size_gib × 0.10                        (Relayed，占位保守附加价)
estimated_cost = egress_cost + relay_cost

effective_mbps = min(receiver_ingress, provider_egress)
estimated_seconds = B × 8 / (effective_mbps × 1,000,000)
                    × (1 + provider_load) + measured_rtt
```

先剔除过期、非法、货币不一致和超过 `max_cost` 的候选。私网路径永远优先于计费路径；同一路径等级内：

- `cost`：价格优先，时间打破平局。
- `speed`：预计时间优先，价格打破平局。
- `balanced`：使用 `cost / budget + seconds / 3600` 的归一化分数。

当前带宽和负载来自节点声明，RTT 来自 Ping；因此 ETA 是启发式估计。下一版应以传输 EWMA 覆盖自报吞吐，并按失败率、完整性历史和最近可用性形成信誉分。

更完善的多路径计划不应只选一个 provider，而应建立候选图：边表示可达传输方式，边权包含货币成本、时间、失败概率和信任等级。分块调度器可以在预算内把块分配给多个 provider，并在拥塞或价格窗口切换时重算未开始的块。

## 6. 数据传输与失败处理

对象存入 `objects/<sha256>`。协议使用 1 MiB 分块，避免超过 CBOR request-response 的默认响应上限，并限制失败重试的浪费。

```text
查询 provider 与最新 inventory
  → 生成有序候选计划
  → 请求 chunk 0..N
      → 校验 chunk SHA-256
      → 失败则同一 chunk 切到下一候选
  → 顺序写入临时文件
  → 校验整文件 SHA-256
  → 原子发布到本地内容存储
  → 导出到用户路径
  → 发送 TransferReceipt
```

当前下载失败不会把部分文件发布为对象，但还不能从部分块断点恢复。后续应增加 manifest、已验证块 bitmap、每块独立临时文件和并发窗口；恢复时只接受哈希一致的已有块。

不同 provider 宣称同一 SHA-256 时，消费者仍以哈希校验为准。恶意节点最多造成带宽与时间浪费，不能让错误内容以目标对象 ID 提交；生产环境仍需限速、封禁和信誉衰减来抵抗持续 DoS。

## 6.1 Agent 消息与任务

`DeliverEnvelope` 承载 `message`、`task`、`task_cancel`、`task_progress` 和 `task_result`。信封带 UUID、发送/接收 Peer ID、网络、TTL、关联任务 UUID 与 JSON payload。接收端核对实际连接 Peer ID 和 allowlist，原子写入 inbox 后才 ACK；重复 UUID 不会重复落盘。

Harness 采用 Leader 联邦而不是跨节点 Agent Team。每个节点只声明一个 `dsh-leader/1` 入口，teammate 永远留在本地。绑定的 Leader 收到 task 后可用本机 subagent/Agent Team 处理；`MeshLeaderProvider` 在发送端只创建一个远端 `SubagentRun` 代理。取消和结果通过 correlation ID 对齐。默认跨节点 hop budget 为 1，经过一次 Leader 委派后归零，但不限制远端 Leader 的本地 Team 调度。

当前 inbox 是至少一次语义：崩溃窗口可能让任务重复激活，调用方应提供幂等任务。执行 lease、任务 journal 和已完成结果缓存属于下一阶段。

## 7. 删除协议

删除需要同时满足：

1. 提供方以 `--allow-source-delete` 明确允许。
2. 接收方以 `--request-source-delete` 明确请求。
3. 提供方记录到同一个接收方 Peer ID 已实际请求全部分块。
4. 接收方已经计算出整文件 SHA-256，并把匹配的哈希放入回执。
5. 提供方确认本地对象仍存在且对象 ID 匹配。

满足后只执行：

```text
objects/<sha256> → delete-pending/<sha256>
```

对象立即停止出现在 inventory 中，但数据尚未不可恢复地删除。分块发送记录当前只保存在进程内，提供方重启后会安全地拒绝旧回执。生产协议还需要带签名的传输事务 ID、持久化重放保护、成员 ACL、保留期限、审计日志、多副本阈值和幂等 GC。仅凭“某个陌生 Peer 收到过数据”不能成为销毁唯一副本的充分条件。

## 8. 威胁模型与生产门槛

当前可抵御：

- 传输窃听和普通中间人篡改：Noise/QUIC 加密并认证 Peer ID。
- 内容静默损坏：分块哈希和整对象内容寻址。
- 过期资源状态长期参与计划：短 TTL。
- 单方意外触发删除：双向开关、完整性回执和可恢复待删除区。

当前不能抵御：

- Sybil、恶意自报价格/带宽/负载、同一身份私钥被盗。
- 未授权成员读取 inventory 或对象；`network_id` 不是 ACL。
- 流量分析、恶意消耗带宽/连接/磁盘、DHT 污染和 eclipse 攻击。
- 提供方看到明文内容；传输加密不等于端到端存储加密。
- 自报价格与云厂商实际账单不一致。

生产准入至少需要：组织 CA 或显式 Peer allowlist、每对象/命名空间 ACL、challenge-response 成员证明、速率与并发限制、磁盘配额、价格表签名及账单对账、审计事件、密钥轮换和撤销。敏感数据应客户端加密后再按密文哈希寻址。

## 9. NAT 与 relay

直接 TCP/QUIC 和 mDNS 已实现。互联网部署下一步应加入：

- AutoNAT 判断公网可达性。
- Identify Push 更新外部地址。
- DCUtR/打洞优先建立直连。
- Circuit Relay v2 作为最后回退，并让 relay 发布容量、地域、限额和价格。
- 已走 relay 的连接若打洞成功，未开始的块迁移到直连路径。

Relay 不应只是布尔能力；最终模型中 relay 是独立资源提供者，路径成本应分别计算源节点出口、relay 流量和目的节点入口，而不是使用当前 0.10/GiB 占位加价。

## 10. 与 UCloud US3 的关系

US3 adapter 应作为 agent 的一种本地资源，而不是让 DHT 直接暴露云凭证：

```text
P2P GetChunk
  → agent 本地授权/预算检查
  → US3 内网 endpoint 或本地缓存读取
  → 内容校验
  → P2P 加密连接返回
```

每个 agent 可声明自己靠近哪个地域/VPC、是否已有缓存、出口价格窗口与可用带宽。调度器优先选择同 VPC 免费路径或已有边缘副本，避免同一对象重复从 US3 公网下载。

这不会消除首次离开云地域的必要出口费用。真正的收益来自：一次付费拉出后在 P2P 网络复用、跨地域选择更低价出口、闲时迁移，以及让消费方从最近缓存取数。报价必须和 UCloud 实际账单异步对账，不能把自报估算当账单事实。

## 11. 演进顺序

1. **当前 MVP**：稳定身份、声明、局域网/显式入口发现、Kademlia provider、分块校验、预算选路、可恢复删除。
2. **可靠传输**：断点续传、并发窗口、EWMA 吞吐、provider 失败熔断、磁盘配额。
3. **复杂网络**：AutoNAT、打洞、Circuit Relay v2、路径动态升级。
4. **可信成员**：在现有 Peer allowlist 上增加组织证书、对象 ACL、声明签名策略、审计、信誉和 Sybil 防护。
5. **资源适配**：US3/S3、本地目录、HTTP 源、带宽和存储 worker；统一 manifest。
6. **结算与调度**：签名价格表、实际账单对账、多 provider 并行优化、租户预算账本。
