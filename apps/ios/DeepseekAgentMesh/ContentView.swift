import SwiftUI

private enum MeshTheme {
    static let indigo = Color(red: 0.34, green: 0.31, blue: 0.92)
    static let cyan = Color(red: 0.08, green: 0.72, blue: 0.76)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
}

private struct ComposeContext: Identifiable {
    let id = UUID()
    let mode: ComposerMode
    let targetID: String?
}

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @State private var composer: ComposeContext?

    var body: some View {
        TabView {
            NavigationStack { DashboardView(composer: $composer) }
                .tabItem { Label("总览", systemImage: "square.grid.2x2.fill") }
            NavigationStack { LeadersView(composer: $composer) }
                .tabItem { Label("Leader", systemImage: "point.3.connected.trianglepath.dotted") }
            NavigationStack { ChatsView() }
                .tabItem { Label("群聊", systemImage: "bubble.left.and.bubble.right.fill") }
            NavigationStack { InboxView() }
                .tabItem { Label("动态", systemImage: "tray.full.fill") }
                .badge(model.unreadCount)
            NavigationStack { SettingsView() }
                .tabItem { Label("设置", systemImage: "gearshape.fill") }
        }
        .tint(MeshTheme.indigo)
        .sheet(item: $composer) { context in
            ComposeSheet(mode: context.mode, initialTargetID: context.targetID)
                .environmentObject(model)
        }
        .alert("DeepSeek Agent Mesh", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("好") { model.errorMessage = nil } } message: {
            Text(model.errorMessage ?? "")
        }
        .task { model.bootstrap() }
    }
}

private struct ChatsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingCreate = false

    var body: some View {
        Group {
            if model.rooms.isEmpty {
                ContentUnavailableView(
                    "还没有 Leader 群聊",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("建一个房间，把不同节点的 Leader 拉进来直接聊天。")
                )
            } else {
                List(model.rooms) { room in
                    NavigationLink { ChatDetailView(roomID: room.id) } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                Text(room.name).font(.headline).lineLimit(1)
                                Spacer()
                                Circle().fill(room.isOpen ? Color.green : Color.secondary)
                                    .frame(width: 8, height: 8)
                            }
                            Text(room.lastMessage?.body ?? (room.description.isEmpty ? "还没有消息" : room.description))
                                .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                            HStack(spacing: 12) {
                                Label("\(room.participants.count) Leader", systemImage: "person.3")
                                Label("\(room.messages.count) 条消息", systemImage: "message")
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 5)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Leader 群聊")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingCreate = true } label: { Image(systemName: "plus") }
                    .disabled(!model.isRunning || !model.leaders.contains(where: \.supportsChat))
            }
        }
        .sheet(isPresented: $showingCreate) { CreateChatSheet() }
        .refreshable { model.refresh() }
    }
}

private struct CreateChatSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var selected = Set<String>()

    private var chatLeaders: [LeaderPeer] { model.leaders.filter(\.supportsChat) }

    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !selected.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("群聊") {
                    TextField("群聊名称", text: $name)
                    TextField("聊什么（可选）", text: $description, axis: .vertical).lineLimit(2...4)
                }
                Section("成员（\(selected.count)）") {
                    ForEach(chatLeaders) { leader in
                        Button {
                            if selected.contains(leader.id) { selected.remove(leader.id) }
                            else if selected.count < 5 { selected.insert(leader.id) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(leader.name).foregroundStyle(.primary)
                                    Text(leader.roles.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: selected.contains(leader.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selected.contains(leader.id) ? MeshTheme.indigo : .secondary)
                            }
                        }
                    }
                }
                Section {
                    Label("你每发一条消息，每个在线 Leader 最多回复一次。Leader 回复不会再次触发其他 Leader。", systemImage: "arrow.triangle.branch")
                    Label("房间默认保留 200 次发言额度，单条最多 4 KiB；这些限制只负责防止流量爆炸。", systemImage: "gauge.with.dots.needle.33percent")
                }
                .font(.footnote).foregroundStyle(.secondary)
            }
            .navigationTitle("新建群聊")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") {
                        model.createRoom(name: name, description: description, participantIDs: Array(selected))
                        dismiss()
                    }
                    .fontWeight(.semibold).disabled(!canCreate)
                }
            }
            .onAppear {
                if selected.isEmpty { selected = Set(chatLeaders.prefix(5).map(\.id)) }
            }
        }
    }
}

private struct ChatDetailView: View {
    @EnvironmentObject private var model: AppModel
    let roomID: String
    @State private var draft = ""

    private var room: ChatRoom? { model.rooms.first { $0.id == roomID } }

    var body: some View {
        Group {
            if let room {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ChatRoomHeader(room: room)
                            if room.messages.isEmpty {
                                ContentUnavailableView(
                                    "开始聊天",
                                    systemImage: "bubble.left",
                                    description: Text("发一条消息，房间里的 Leader 会各自判断是否需要回应。")
                                )
                                .padding(.top, 56)
                            } else {
                                ForEach(room.messages) { message in
                                    ChatBubble(
                                        message: message,
                                        senderName: senderName(message)
                                    )
                                    .id(message.id)
                                }
                            }
                        }
                        .padding(.horizontal)
                        .padding(.bottom, 12)
                    }
                    .background(Color(uiColor: .systemGroupedBackground))
                    .onChange(of: room.messages.count) {
                        if let id = room.messages.last?.id {
                            withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                        }
                    }
                }
                .safeAreaInset(edge: .bottom) { composer(room) }
                .navigationTitle(room.name)
                .navigationBarTitleDisplayMode(.inline)
            } else {
                ContentUnavailableView("群聊不可用", systemImage: "exclamationmark.triangle")
            }
        }
    }

    private func senderName(_ message: ChatMessage) -> String {
        if message.authorRole == .watcher { return model.nodeName }
        return model.leaders.first(where: { $0.id == message.authorPeer })?.name
            ?? String(message.authorPeer.prefix(12))
    }

    private func composer(_ room: ChatRoom) -> some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("发消息给 Leader…", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
            Button {
                let message = draft
                draft = ""
                model.sendChatMessage(message, roomID: room.id)
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                      || model.isSending || !room.isOpen || room.remainingTurns == 0)
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
}

private struct ChatRoomHeader: View {
    let room: ChatRoom

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "person.3.fill")
                .font(.title2).foregroundStyle(MeshTheme.indigo)
                .frame(width: 48, height: 48)
                .background(MeshTheme.indigo.opacity(0.12), in: Circle())
            if !room.description.isEmpty {
                Text(room.description).font(.subheadline).multilineTextAlignment(.center)
            }
            Text("\(room.participants.count) 位 Leader · 每次最多 \(room.maxRespondersPerTurn) 条回复 · 剩余 \(room.remainingTurns) 次")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 18)
    }
}

private struct ChatBubble: View {
    let message: ChatMessage
    let senderName: String

    var body: some View {
        if message.authorRole == .system {
            Text(message.body).font(.caption).foregroundStyle(.secondary)
                .padding(.vertical, 4).frame(maxWidth: .infinity)
        } else {
            HStack {
                if message.authorRole == .watcher { Spacer(minLength: 54) }
                VStack(alignment: message.authorRole == .watcher ? .trailing : .leading, spacing: 4) {
                    Text(senderName).font(.caption).foregroundStyle(.secondary)
                    Text(message.body)
                        .font(.body)
                        .foregroundStyle(message.authorRole == .watcher ? Color.white : Color.primary)
                        .padding(.horizontal, 13).padding(.vertical, 9)
                        .background(message.authorRole == .watcher ? MeshTheme.indigo : MeshTheme.card,
                                    in: RoundedRectangle(cornerRadius: 17))
                    Text(message.createdAt.formatted(date: .omitted, time: .shortened))
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                if message.authorRole != .watcher { Spacer(minLength: 54) }
            }
        }
    }
}

private struct DashboardView: View {
    @EnvironmentObject private var model: AppModel
    @Binding var composer: ComposeContext?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                NetworkHero(composer: $composer)

                HStack(spacing: 12) {
                    MetricCard(value: "\(model.leaders.count)", label: "在线 Leader", icon: "cpu", tint: MeshTheme.cyan)
                    MetricCard(value: "\(model.activeTaskCount)", label: "进行中任务", icon: "bolt.horizontal.circle", tint: .orange)
                    MetricCard(value: "\(model.unreadCount)", label: "未读结果", icon: "envelope.badge", tint: MeshTheme.indigo)
                }

                SectionCard(title: "Leader 拓扑", actionTitle: model.isRunning ? "刷新" : nil, action: model.refresh) {
                    if model.leaders.isEmpty {
                        CompactEmptyState(
                            icon: model.isRunning ? "antenna.radiowaves.left.and.right.slash" : "power",
                            title: model.isRunning ? "尚未发现 Leader" : "Watcher 尚未连接",
                            detail: model.isRunning ? "检查 WireGuard、bootstrap 与远端节点状态" : "在设置中输入邀请并加入 Mesh"
                        )
                    } else {
                        ForEach(model.leaders.prefix(3)) { leader in
                            NavigationLink(value: leader) { LeaderRow(leader: leader) }
                                .buttonStyle(.plain)
                            if leader.id != model.leaders.prefix(3).last?.id { Divider() }
                        }
                    }
                }

                SectionCard(title: "最近动态") {
                    if model.events.isEmpty {
                        CompactEmptyState(icon: "waveform.path.ecg", title: "还没有动态", detail: "消息、任务和网络事件会保存在这里")
                    } else {
                        ForEach(model.events.prefix(5)) { event in
                            NavigationLink { EventDetailView(event: event) } label: { EventRow(event: event) }
                                .buttonStyle(.plain)
                            if event.id != model.events.prefix(5).last?.id { Divider() }
                        }
                    }
                }
            }
            .padding()
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Agent Mesh")
        .navigationDestination(for: LeaderPeer.self) { leader in
            LeaderDetailView(leader: leader, composer: $composer)
        }
        .refreshable { model.refresh() }
    }
}

private struct NetworkHero: View {
    @EnvironmentObject private var model: AppModel
    @Binding var composer: ComposeContext?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(model.isRunning ? Color.green : Color.white.opacity(0.55))
                            .frame(width: 9, height: 9)
                            .shadow(color: model.isRunning ? .green.opacity(0.8) : .clear, radius: 5)
                        Text(model.isRunning ? "MESH ONLINE" : "MESH OFFLINE")
                            .font(.caption.weight(.bold)).tracking(1.2)
                    }
                    Text(model.isRunning ? "\(model.leaders.count) 个 Harness Leader 可达" : "连接后即可管理 Leader")
                        .font(.title2.bold())
                }
                Spacer()
                Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                    .font(.title2)
                    .padding(12)
                    .background(.white.opacity(0.14), in: Circle())
            }

            HStack(spacing: 10) {
                HeroAction(title: "发消息", icon: "paperplane.fill", prominent: true) {
                    composer = ComposeContext(mode: .message, targetID: nil)
                }
                HeroAction(title: "派任务", icon: "bolt.fill", prominent: false) {
                    composer = ComposeContext(mode: .task, targetID: model.leaders.first?.id)
                }
            }
            .disabled(!model.isRunning || model.leaders.isEmpty)
        }
        .foregroundStyle(.white)
        .padding(20)
        .background(
            LinearGradient(colors: [MeshTheme.indigo, Color(red: 0.20, green: 0.23, blue: 0.55), MeshTheme.cyan.opacity(0.9)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .shadow(color: MeshTheme.indigo.opacity(0.22), radius: 18, y: 8)
        .accessibilityElement(children: .contain)
    }
}

private struct HeroAction: View {
    let title: String
    let icon: String
    let prominent: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.subheadline.bold())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(prominent ? Color.white : Color.white.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(prominent ? MeshTheme.indigo : .white)
        }
        .buttonStyle(.plain)
    }
}

private struct MetricCard: View {
    let value: String
    let label: String
    let icon: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: icon).foregroundStyle(tint).font(.headline)
            Text(value).font(.title2.bold()).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(MeshTheme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct SectionCard<Content: View>: View {
    let title: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                if let actionTitle, let action {
                    Button(actionTitle, action: action).font(.subheadline)
                }
            }
            content
        }
        .padding(16)
        .background(MeshTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct LeadersView: View {
    @EnvironmentObject private var model: AppModel
    @Binding var composer: ComposeContext?
    @State private var query = ""

    private var filtered: [LeaderPeer] {
        guard !query.isEmpty else { return model.leaders }
        return model.leaders.filter { leader in
            leader.name.localizedCaseInsensitiveContains(query) ||
            leader.roles.contains(where: { $0.localizedCaseInsensitiveContains(query) }) ||
            leader.id.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        Group {
            if filtered.isEmpty {
                ContentUnavailableView(
                    query.isEmpty ? "没有在线 Leader" : "没有匹配项",
                    systemImage: query.isEmpty ? "cpu" : "magnifyingglass",
                    description: Text(query.isEmpty ? "连接 Mesh 后，可执行任务的 Harness Leader 会出现在这里。" : "尝试搜索节点名、角色或 Peer ID。")
                )
            } else {
                List(filtered) { leader in
                    NavigationLink(value: leader) { LeaderRow(leader: leader) }
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button { composer = ComposeContext(mode: .message, targetID: leader.id) } label: {
                                Label("消息", systemImage: "paperplane")
                            }.tint(MeshTheme.cyan)
                            Button { composer = ComposeContext(mode: .task, targetID: leader.id) } label: {
                                Label("任务", systemImage: "bolt")
                            }.tint(.orange)
                        }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Harness Leader")
        .searchable(text: $query, prompt: "搜索 Leader、角色或 Peer ID")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { composer = ComposeContext(mode: .message, targetID: nil) } label: {
                    Image(systemName: "square.and.pencil")
                }.disabled(!model.isRunning || model.leaders.isEmpty)
            }
        }
        .navigationDestination(for: LeaderPeer.self) { leader in
            LeaderDetailView(leader: leader, composer: $composer)
        }
        .refreshable { model.refresh() }
    }
}

private struct LeaderRow: View {
    let leader: LeaderPeer

    var body: some View {
        HStack(spacing: 13) {
            ZStack(alignment: .bottomTrailing) {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(LinearGradient(colors: [MeshTheme.indigo.opacity(0.85), MeshTheme.cyan], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 48, height: 48)
                Text(String(leader.name.prefix(1)).uppercased()).font(.headline.bold()).foregroundStyle(.white)
                Circle().fill(leader.isResponsive ? .green : .orange).frame(width: 12, height: 12)
                    .overlay(Circle().stroke(MeshTheme.card, lineWidth: 2))
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(leader.name).font(.headline).lineLimit(1)
                HStack(spacing: 5) {
                    Text(leader.route)
                    Text("·")
                    Text("\(Int(leader.rttMilliseconds)) ms")
                    if !leader.location.isEmpty { Text("·"); Text(leader.location) }
                }
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if !leader.roles.isEmpty {
                    Text(leader.roles.prefix(3).joined(separator: "  ·  "))
                        .font(.caption2.weight(.medium)).foregroundStyle(MeshTheme.indigo)
                }
            }
            Spacer(minLength: 4)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(leader.name)，\(leader.route)，延迟 \(Int(leader.rttMilliseconds)) 毫秒")
    }
}

private struct LeaderDetailView: View {
    let leader: LeaderPeer
    @Binding var composer: ComposeContext?

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(LinearGradient(colors: [MeshTheme.indigo, MeshTheme.cyan], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 76, height: 76)
                        .overlay(Text(String(leader.name.prefix(1)).uppercased()).font(.largeTitle.bold()).foregroundStyle(.white))
                    Text(leader.name).font(.title2.bold())
                    Label("在线 · \(leader.route) · \(Int(leader.rttMilliseconds)) ms", systemImage: "circle.fill")
                        .font(.subheadline).foregroundStyle(leader.isResponsive ? .green : .orange)
                    HStack {
                        Button { composer = ComposeContext(mode: .message, targetID: leader.id) } label: {
                            Label("发消息", systemImage: "paperplane.fill").frame(maxWidth: .infinity)
                        }.buttonStyle(.bordered)
                        Button { composer = ComposeContext(mode: .task, targetID: leader.id) } label: {
                            Label("派任务", systemImage: "bolt.fill").frame(maxWidth: .infinity)
                        }.buttonStyle(.borderedProminent).tint(MeshTheme.indigo)
                    }.padding(.top, 6)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }
            Section("能力") {
                LabeledContent("Agent Team", value: leader.teamEnabled ? "可用" : "未声明")
                LabeledContent("最大并行任务", value: "\(leader.maxParallelTasks)")
                LabeledContent("当前负载", value: "\(Int(leader.load * 100))%")
                LabeledContent("角色", value: leader.roles.isEmpty ? "通用" : leader.roles.joined(separator: "、"))
                LabeledContent("Workspace", value: leader.workspaces.isEmpty ? "default" : leader.workspaces.joined(separator: "、"))
            }
            Section("节点信息") {
                LabeledContent("区域", value: leader.location.isEmpty ? "未声明" : leader.location)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Peer ID").font(.caption).foregroundStyle(.secondary)
                    Text(leader.id).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        }
        .navigationTitle("Leader 详情")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private enum HistoryFilter: String, CaseIterable, Identifiable {
    case all = "全部"
    case message = "消息"
    case task = "任务"
    var id: String { rawValue }
}

private struct InboxView: View {
    @EnvironmentObject private var model: AppModel
    @State private var filter = HistoryFilter.all

    private var filtered: [OperatorEvent] {
        switch filter {
        case .all: model.events
        case .message: model.events.filter { $0.kind == .message }
        case .task: model.events.filter { $0.kind == .task }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("动态类型", selection: $filter) {
                ForEach(HistoryFilter.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding()

            if filtered.isEmpty {
                ContentUnavailableView("暂无\(filter == .all ? "动态" : filter.rawValue)", systemImage: "tray", description: Text("发送消息或任务后，投递状态和结果会显示在这里。"))
            } else {
                List(filtered) { event in
                    NavigationLink { EventDetailView(event: event) } label: { EventRow(event: event) }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("消息与任务")
    }
}

private struct EventRow: View {
    let event: OperatorEvent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.bold())
                .foregroundStyle(tint)
                .frame(width: 34, height: 34)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(event.title).font(.headline).lineLimit(1)
                    if event.unread { Circle().fill(MeshTheme.indigo).frame(width: 7, height: 7) }
                    Spacer()
                    Text(event.createdAt, style: .relative).font(.caption2).foregroundStyle(.secondary)
                }
                Text(event.body).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                HStack(spacing: 5) {
                    Text(event.direction == .outbound ? "发往" : "来自")
                    Text(event.primaryPeerName)
                    if event.kind != .system {
                        Text("·")
                        Text(event.overallState.title).foregroundStyle(stateColor)
                    }
                }.font(.caption)
            }
        }
        .padding(.vertical, 5)
    }

    private var icon: String {
        switch event.kind {
        case .message: event.direction == .inbound ? "arrow.down.message.fill" : "paperplane.fill"
        case .task: "bolt.fill"
        case .system: "network"
        }
    }
    private var tint: Color { event.kind == .task ? .orange : (event.kind == .system ? .secondary : MeshTheme.indigo) }
    private var stateColor: Color { event.overallState == .failed ? .red : (event.overallState == .completed ? .green : .secondary) }
}

private struct EventDetailView: View {
    @EnvironmentObject private var model: AppModel
    let event: OperatorEvent

    var body: some View {
        List {
            Section("内容") {
                Text(event.body).textSelection(.enabled)
            }
            if let result = event.result, !result.isEmpty {
                Section("Leader 返回") { Text(result).textSelection(.enabled) }
            }
            if !event.receipts.isEmpty {
                Section(event.isBroadcast ? "广播投递" : "投递") {
                    ForEach(event.receipts) { receipt in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(receipt.peerName)
                                Spacer()
                                StatusPill(state: receipt.state)
                            }
                            if let diagnostic = receipt.diagnostic {
                                Text(diagnostic).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                            }
                        }
                    }
                }
            }
            Section("时间") {
                LabeledContent("创建", value: event.createdAt.formatted(date: .abbreviated, time: .standard))
                if event.updatedAt != event.createdAt {
                    LabeledContent("更新", value: event.updatedAt.formatted(date: .abbreviated, time: .standard))
                }
            }
        }
        .navigationTitle(event.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { model.markRead(event.id) }
    }
}

private struct StatusPill: View {
    let state: DeliveryState
    var body: some View {
        Text(state.title)
            .font(.caption2.bold())
            .padding(.horizontal, 8).padding(.vertical, 4)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }
    private var color: Color {
        switch state {
        case .failed: .red
        case .completed: .green
        case .running: .orange
        case .sending, .delivered: MeshTheme.indigo
        }
    }
}

private struct ComposeSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var mode: ComposerMode
    @State private var targetID: String
    @State private var subject = ""
    @State private var bodyText = ""
    @State private var confirmingBroadcast = false

    init(mode: ComposerMode, initialTargetID: String?) {
        _mode = State(initialValue: mode)
        _targetID = State(initialValue: initialTargetID ?? (mode == .message ? "all" : ""))
    }

    private var selectedTargets: [LeaderPeer] {
        targetID == "all" ? model.leaders : model.leaders.filter { $0.id == targetID }
    }
    private var canSend: Bool {
        model.isRunning && !model.isSending && !bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !selectedTargets.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("类型", selection: $mode) {
                        ForEach(ComposerMode.allCases) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented)
                }
                Section("接收者") {
                    Picker("Leader", selection: $targetID) {
                        if mode == .message { Text("所有在线 Leader（\(model.leaders.count)）").tag("all") }
                        ForEach(model.leaders) { leader in Text(leader.name).tag(leader.id) }
                    }
                    if targetID == "all" {
                        Label("将分别加密投递给当前在线的 \(model.leaders.count) 个 Leader", systemImage: "person.3.fill")
                            .font(.footnote).foregroundStyle(.secondary)
                    } else if let leader = selectedTargets.first {
                        Label("\(leader.route) · \(Int(leader.rttMilliseconds)) ms · \(leader.roles.first ?? "general")", systemImage: "checkmark.circle.fill")
                            .font(.footnote).foregroundStyle(.green)
                    }
                }
                Section(mode == .message ? "消息" : "任务") {
                    TextField(mode == .message ? "主题（可选）" : "任务名称（可选）", text: $subject)
                    TextEditor(text: $bodyText)
                        .frame(minHeight: 150)
                        .accessibilityLabel(mode == .message ? "消息正文" : "任务说明")
                }
                if mode == .task {
                    Section {
                        Label("任务将交给该 Leader，由它自己的 Agent Team 决定如何执行；手机不会加入远端 Agent Team。", systemImage: "info.circle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(mode == .message ? "新消息" : "派发任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("发送") {
                        if mode == .message && targetID == "all" && model.leaders.count > 1 {
                            confirmingBroadcast = true
                        } else { send() }
                    }
                    .fontWeight(.semibold)
                    .disabled(!canSend)
                }
            }
            .onAppear {
                if targetID.isEmpty { targetID = model.leaders.first?.id ?? "" }
            }
            .onChange(of: mode) { _, newMode in
                if newMode == .task && targetID == "all" { targetID = model.leaders.first?.id ?? "" }
            }
            .confirmationDialog(
                "发送给所有在线 Leader？",
                isPresented: $confirmingBroadcast,
                titleVisibility: .visible
            ) {
                Button("发送给 \(model.leaders.count) 个 Leader") { send() }
                Button("取消", role: .cancel) {}
            } message: {
                Text("每个 Leader 会收到一份独立消息，投递状态可在“动态”中查看。")
            }
        }
        .interactiveDismissDisabled(model.isSending)
    }

    private func send() {
        if mode == .message {
            model.sendMessage(subject: subject, body: bodyText, to: selectedTargets.map(\.id))
        } else if let peerID = selectedTargets.first?.id {
            model.sendTask(label: subject, prompt: bodyText, to: peerID)
        }
        dismiss()
    }
}

private struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmingClear = false

    var body: some View {
        Form {
            Section("连接") {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.isRunning ? "已加入 Mesh" : "未连接").font(.headline)
                        Text(model.isRunning ? "仅在 App 前台保持在线" : "输入邀请后启动 Watcher")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Circle().fill(model.isRunning ? .green : .secondary).frame(width: 10, height: 10)
                }
                Button {
                    model.isRunning ? model.stop() : model.start()
                } label: {
                    HStack {
                        if model.isTransitioning { ProgressView().controlSize(.small) }
                        Text(model.isRunning ? "断开连接" : "加入并启动")
                    }.frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(model.isRunning ? .red : MeshTheme.indigo)
                .disabled(model.isTransitioning)
            }

            Section("Watcher 身份") {
                TextField("设备名称", text: $model.nodeName).disabled(model.isRunning)
                TextField("Network ID", text: $model.networkID)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(model.isRunning)
                if !model.isRunning {
                    TextField("mesh1h:…（首次加入时粘贴）", text: $model.joinCode, axis: .vertical)
                        .font(.caption.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                if !model.peerID.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Peer ID").font(.caption).foregroundStyle(.secondary)
                        Text(model.peerID).font(.caption2.monospaced()).textSelection(.enabled)
                        Button("复制 Peer ID") { UIPasteboard.general.string = model.peerID }
                    }
                }
                Text("首次加入后，签名身份与 membership 保存在 App 沙盒；下次打开会自动重连。")
                    .font(.footnote).foregroundStyle(.secondary)
            }

            Section("运行边界") {
                Label("这是 Mesh Watcher，不是 Harness Leader。它可以查看 Leader、发送消息和派发任务，但不会在手机上执行 Agent 任务。", systemImage: "iphone.and.arrow.forward")
                Label("iOS 挂起普通 App 后网络会暂停；回到前台时，持久 inbox 会继续同步结果。", systemImage: "moon.zzz")
            }
            .font(.footnote).foregroundStyle(.secondary)

            Section("本地数据") {
                Button("清除消息与任务历史", role: .destructive) { confirmingClear = true }
            }

            Section {
                LabeledContent("协议", value: "mesh-watcher/1")
                LabeledContent("任务兼容", value: "dsh-leader/1")
                LabeledContent("版本", value: "0.2.1")
            } header: { Text("关于") } footer: {
                Text("DeepSeek Agent Mesh · sovereign leaders, direct coordination")
            }
        }
        .navigationTitle("设置")
        .confirmationDialog("清除全部本地历史？", isPresented: $confirmingClear, titleVisibility: .visible) {
            Button("清除", role: .destructive) { model.clearHistory() }
            Button("取消", role: .cancel) {}
        } message: { Text("这不会删除 Mesh 中已经投递的消息或任务。") }
    }
}

private struct CompactEmptyState: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.title3).foregroundStyle(.secondary).frame(width: 36, height: 36)
                .background(Color.secondary.opacity(0.1), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
    }
}
