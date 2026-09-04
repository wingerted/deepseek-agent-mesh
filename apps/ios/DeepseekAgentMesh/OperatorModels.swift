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
    let load: Double
    let teamEnabled: Bool
    let maxParallelTasks: Int

    var isResponsive: Bool { rttMilliseconds < 1_500 }
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

enum DeliberationPhase: String, Codable {
    case capability
    case deliberation
    case vote
    case closed

    var title: String {
        switch self {
        case .capability: "能力申报"
        case .deliberation: "讨论"
        case .vote: "表决"
        case .closed: "已决议"
        }
    }
}

struct RoomContribution: Identifiable, Hashable {
    let id: String
    let authorPeer: String
    let round: Int
    let kind: String
    let confidence: Double
    let body: String
    let vote: String?

    static func parse(_ value: [String: Any]) -> RoomContribution? {
        guard let id = value["id"] as? String,
              let author = value["author_peer"] as? String else { return nil }
        return RoomContribution(
            id: id,
            authorPeer: author,
            round: (value["round"] as? NSNumber)?.intValue ?? 0,
            kind: value["kind"] as? String ?? "unknown",
            confidence: (value["confidence"] as? NSNumber)?.doubleValue ?? 0,
            body: value["body"] as? String ?? "",
            vote: value["vote"] as? String
        )
    }
}

struct RoomDecision: Hashable {
    let outcome: String
    let cast: Int
    let eligible: Int
    let approvals: Int
    let rejections: Int
    let abstentions: Int
    let quorumReached: Bool
    let approvalReached: Bool

    static func parse(_ value: [String: Any]?) -> RoomDecision? {
        guard let value, let outcome = value["outcome"] as? String else { return nil }
        return RoomDecision(
            outcome: outcome,
            cast: (value["cast"] as? NSNumber)?.intValue ?? 0,
            eligible: (value["eligible"] as? NSNumber)?.intValue ?? 0,
            approvals: (value["approvals"] as? NSNumber)?.intValue ?? 0,
            rejections: (value["rejections"] as? NSNumber)?.intValue ?? 0,
            abstentions: (value["abstentions"] as? NSNumber)?.intValue ?? 0,
            quorumReached: value["quorum_reached"] as? Bool ?? false,
            approvalReached: value["approval_reached"] as? Bool ?? false
        )
    }
}

struct DeliberationRoom: Identifiable, Hashable {
    let id: String
    let facilitatorPeer: String
    let topic: String
    let goal: String
    let participants: [String]
    let phase: DeliberationPhase
    let round: Int
    let maxRounds: Int
    let maxSpeakers: Int
    let maxMessageBytes: Int
    let contributions: [RoomContribution]
    let decision: RoomDecision?

    var phaseTitle: String {
        phase == .deliberation ? "第 \(round)/\(maxRounds) 轮" : phase.title
    }

    static func parse(_ value: [String: Any]) -> DeliberationRoom? {
        guard let id = value["id"] as? String,
              let facilitator = value["facilitator_peer"] as? String,
              let contract = value["contract"] as? [String: Any],
              let phaseText = value["phase"] as? String,
              let phase = DeliberationPhase(rawValue: phaseText) else { return nil }
        return DeliberationRoom(
            id: id,
            facilitatorPeer: facilitator,
            topic: contract["topic"] as? String ?? "未命名协商",
            goal: contract["goal"] as? String ?? "",
            participants: (contract["participants"] as? [String] ?? []).sorted(),
            phase: phase,
            round: (value["round"] as? NSNumber)?.intValue ?? 0,
            maxRounds: (contract["max_rounds"] as? NSNumber)?.intValue ?? 1,
            maxSpeakers: (contract["max_speakers"] as? NSNumber)?.intValue ?? 1,
            maxMessageBytes: (contract["max_message_bytes"] as? NSNumber)?.intValue ?? 4096,
            contributions: (value["contributions"] as? [[String: Any]] ?? []).compactMap(RoomContribution.parse),
            decision: RoomDecision.parse(value["decision"] as? [String: Any])
        )
    }
}
