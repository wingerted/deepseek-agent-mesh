# dsh-agent-mesh-web

`agent-mesh` 的 DeepSeek Harness Web 状态插件。它不替代核心 `dsh-agent-mesh` bundle，而是在 Web 设置页增加一个只读的 **Mesh 网络** 页签。

页面展示：

- 本机 daemon、全部绑定/存活的 Leader Session、Peer 数和对象数。
- 本机网络、签名成员身份、rendezvous、配置带宽、价格、接入策略与 Leader/Agent Team 声明。
- Peer 的 route、RTT、负载、地域、存储、对象库存和 Leader 能力。
- 以本机为中心的实时拓扑；私网直连、公网直连和中继使用不同连线。

先安装核心 bundle，再把 Web 插件安装到同一个 profile：

```bash
cd /Users/wingerted/Developer/agent-mesh
pixi run harness-install
```

启动 Harness 后，打开 **设置 → 插件 → Mesh 网络**。面板默认每 5 秒读取一次同源、已认证的 `/api/agent-mesh.snapshot`；离开页签后轮询随组件卸载而停止。

可在 profile 的 patch 中调整 `maxPeers`、`refreshIntervalMs` 和 `requestTimeoutMs`。接口只返回渲染所需的有界数据，不返回 daemon token，也不提供写操作。带宽字段是运营者配置的声明值，页面不把它表述成实测值。
