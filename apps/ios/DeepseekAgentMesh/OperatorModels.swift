import Foundation

struct LeaderPeer: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let route: String
    let rttMilliseconds: Double
    let region: String
    let zone: String
    let roles: [String]
    let workspaces: [String]
    let protocols: [String]
    let load: Double
    let teamEnabled: Bool
    let maxParallelTasks: Int

    var isResponsive: Bool { rttMilliseconds < 1_500 }
    var supportsChat: Bool { protocols.contains("mesh-chat/1") }
    var location: String { [region, zone].filter { !$0.isEmpty }.joined(separator: " · ") }
    var shortID: String { Self.shortened(id) }

    static func parse(_ value: [String: Any]) -> LeaderPeer? {
        guard let peerID = value["peer_id"] as? String,
              let advertisement = value["advertisement"] as? [String: Any],
              let capabilities = advertisement["capabilities"] as? [String: Any],
              let leader = capabilities["leader"] as? [String: Any] else { return nil }

        let protocols = leader["protocols"] as? [String] ?? []
        guard protocols.contains("dsh-leader/1") else { return nil }
        return LeaderPeer(
            id: peerID,
            name: advertisement["agent_name"] as? String ?? "Unnamed Leader",
            route: Self.readableRoute(value["route"] as? String ?? "Unknown"),
            rttMilliseconds: (value["observed_rtt_ms"] as? NSNumber)?.doubleValue ?? 250,
            region: capabilities["region"] as? String ?? "",
            zone: capabilities["zone"] as? String ?? "",
            roles: (leader["roles"] as? [String] ?? []).sorted(),
            workspaces: (leader["workspace_aliases"] as? [String] ?? []).sorted(),
            protocols: protocols.sorted(),
            load: (capabilities["load"] as? NSNumber)?.doubleValue ?? 0,
            teamEnabled: leader["team_enabled"] as? Bool ?? false,
            maxParallelTasks: (leader["max_parallel_tasks"] as? NSNumber)?.intValue ?? 1
        )
    }

    private static func shortened(_ value: String) -> String {
        value.count > 24 ? "\(value.prefix(10))…\(value.suffix(6))" : value
    }

    private static func readableRoute(_ value: String) -> String {
        switch value.lowercased() {
        case "directprivate": return "Private"
        case "directpublic": return "Direct"
        case "relay": return "Relay"
        default: return value
        }
    }
}

enum OperatorEventKind: String, Codable, CaseIterable {
    case message
    case task
    case system
}

enum OperatorDirection: String, Codable {
    case inbound
    case outbound
}

enum DeliveryState: String, Codable {
    case sending
    case delivered
    case running
    case completed
    case failed

    var title: String {
        switch self {
        case .sending: "发送中"
        case .delivered: "已送达"
        case .running: "执行中"
        case .completed: "已完成"
        case .failed: "失败"
        }
    }
}

struct DeliveryReceipt: Identifiable, Codable, Hashable {
    var id: String { peerID }
    let peerID: String
    let peerName: String
    var state: DeliveryState
    var envelopeID: String?
    var diagnostic: String?
}

struct OperatorEvent: Identifiable, Codable, Hashable {
    let id: UUID
    let kind: OperatorEventKind
    let direction: OperatorDirection
    let title: String
    let body: String
    let createdAt: Date
    var updatedAt: Date
    var receipts: [DeliveryReceipt]
    var sourceEnvelopeID: String?
    var result: String?
    var unread: Bool

    var isBroadcast: Bool { receipts.count > 1 }
    var primaryPeerName: String {
        if receipts.count > 1 { return "\(receipts.count) 个 Leader" }
        return receipts.first?.peerName ?? "Mesh"
    }
    var overallState: DeliveryState {
        if receipts.contains(where: { $0.state == .failed }) { return .failed }
        if receipts.allSatisfy({ $0.state == .completed }) { return .completed }
        if receipts.contains(where: { $0.state == .running }) { return .running }
        if receipts.allSatisfy({ $0.state == .delivered || $0.state == .completed }) { return .delivered }
        return .sending
    }
}

enum ComposerMode: String, CaseIterable, Identifiable {
    case message = "消息"
    case task = "任务"
    var id: String { rawValue }
}

struct OperatorHistoryStore {
    private let fileURL: URL

    init(directory: URL) {
        fileURL = directory.appendingPathComponent("operator-history.json")
    }

    func load() -> [OperatorEvent] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([OperatorEvent].self, from: data)) ?? []
    }

    func save(_ events: [OperatorEvent]) {
        guard let data = try? JSONEncoder().encode(Array(events.prefix(500))) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}

enum ChatAuthorRole: String, Hashable {
    case watcher
    case leader
    case system
}

struct ChatMessage: Identifiable, Hashable {
    let id: String
    let authorPeer: String
    let authorRole: ChatAuthorRole
    let kind: String
    let turn: Int
    let body: String
    let replyTo: String?
    let createdAt: Date

    static func parse(_ value: [String: Any]) -> ChatMessage? {
        guard let id = value["id"] as? String,
              let author = value["author_peer"] as? String,
              let roleValue = value["author_role"] as? String,
              let role = ChatAuthorRole(rawValue: roleValue) else { return nil }
        let createdAt = (value["created_at"] as? String)
            .flatMap { ISO8601DateFormatter().date(from: $0) } ?? .now
        return ChatMessage(
            id: id,
            authorPeer: author,
            authorRole: role,
            kind: value["kind"] as? String ?? "unknown",
            turn: (value["turn"] as? NSNumber)?.intValue ?? 0,
            body: value["body"] as? String ?? "",
            replyTo: value["reply_to"] as? String,
            createdAt: createdAt
        )
    }
}

struct ChatRoom: Identifiable, Hashable {
    let id: String
    let hostPeer: String
    let name: String
    let description: String
    let participants: [String]
    let isOpen: Bool
    let turn: Int
    let maxTurns: Int
    let maxRespondersPerTurn: Int
    let maxMessageBytes: Int
    let maxTotalMessages: Int
    let messages: [ChatMessage]

    var remainingTurns: Int { max(0, maxTurns - turn) }
    var lastMessage: ChatMessage? { messages.last }

    static func parse(_ value: [String: Any]) -> ChatRoom? {
        guard let id = value["id"] as? String,
              let host = value["host_peer"] as? String,
              let contract = value["contract"] as? [String: Any] else { return nil }
        return ChatRoom(
            id: id,
            hostPeer: host,
            name: contract["name"] as? String ?? "未命名群聊",
            description: contract["description"] as? String ?? "",
            participants: (contract["participants"] as? [String] ?? []).sorted(),
            isOpen: value["open"] as? Bool ?? false,
            turn: (value["turn"] as? NSNumber)?.intValue ?? 0,
            maxTurns: (contract["max_turns"] as? NSNumber)?.intValue ?? 100,
            maxRespondersPerTurn: (contract["max_responders_per_turn"] as? NSNumber)?.intValue ?? 1,
            maxMessageBytes: (contract["max_message_bytes"] as? NSNumber)?.intValue ?? 4096,
            maxTotalMessages: (contract["max_total_messages"] as? NSNumber)?.intValue ?? 512,
            messages: (value["messages"] as? [[String: Any]] ?? []).compactMap(ChatMessage.parse)
        )
    }
}
