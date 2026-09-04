import Combine
import Foundation
import UIKit

@MainActor
final class AppModel: ObservableObject {
    @Published var nodeName: String
    @Published var networkID = UserDefaults.standard.string(forKey: "networkID") ?? "default"
    @Published var joinCode = ""
    @Published private(set) var isRunning = false
    @Published private(set) var isTransitioning = false
    @Published private(set) var isSending = false
    @Published private(set) var status: [String: Any] = [:]
    @Published private(set) var leaders: [LeaderPeer] = []
    @Published private(set) var events: [OperatorEvent]
    @Published private(set) var rooms: [ChatRoom] = []
    @Published private(set) var lastRefresh: Date?
    @Published var errorMessage: String?

    private let bridge = MeshBridge()
    private let historyStore: OperatorHistoryStore
    private var pollingTask: Task<Void, Never>?
    private var processingEnvelopeIDs = Set<String>()
    private var didBootstrap = false

    var peerID: String { status["peer_id"] as? String ?? "" }
    var connectedPeerCount: Int { (status["connected_peers"] as? NSNumber)?.intValue ?? 0 }
    var unreadCount: Int { events.filter(\.unread).count }
    var activeTaskCount: Int {
        events.filter { $0.kind == .task && [.sending, .delivered, .running].contains($0.overallState) }.count
    }
    var autoConnect: Bool { UserDefaults.standard.bool(forKey: "operatorAutoConnect") }

    init() {
        let savedName = UserDefaults.standard.string(forKey: "operatorName")
        nodeName = savedName?.replacingOccurrences(of: " Operator", with: " Watcher")
            ?? "\(UIDevice.current.name) Watcher"
        let store = OperatorHistoryStore(directory: Self.stateDirectory)
        historyStore = store
        events = store.load().sorted { $0.createdAt > $1.createdAt }
    }

    deinit { pollingTask?.cancel() }

    func bootstrap() {
        guard !didBootstrap else { return }
        didBootstrap = true
        #if DEBUG
        let process = ProcessInfo.processInfo
        if let code = process.environment["MESH_SMOKE_JOIN_CODE"] { joinCode = code }
        if process.arguments.contains("--mesh-smoke-start") || process.environment["MESH_SMOKE_START"] == "1" {
            start()
            return
        }
        #endif
        if autoConnect { start() }
    }

    func start() {
        guard !isRunning, !isTransitioning else { return }
        persistSettings()
        isTransitioning = true
        errorMessage = nil
        let config: [String: Any] = [
            "state_dir": Self.stateDirectory.path,
            "name": nodeName.trimmingCharacters(in: .whitespacesAndNewlines),
            "network_id": networkID.trimmingCharacters(in: .whitespacesAndNewlines),
            "join_code": joinCode.trimmingCharacters(in: .whitespacesAndNewlines),
            "private_networks": ["wireguard"],
            "region": "mobile",
            "zone": "ios",
            "leader_enabled": false,
        ]
        Task {
            do {
                let result = try await Task.detached { [bridge] in try bridge.start(config: config) }.value
                status = result["status"] as? [String: Any] ?? [:]
                isRunning = true
                joinCode = ""
                UserDefaults.standard.set(true, forKey: "operatorAutoConnect")
                appendSystemEvent("Watcher 已加入 \(status["network_id"] as? String ?? networkID)")
                beginPolling()
                await pollOnce(showError: true)
            } catch {
                errorMessage = error.localizedDescription
            }
            isTransitioning = false
        }
    }

    func stop() {
        guard isRunning, !isTransitioning else { return }
        pollingTask?.cancel()
        pollingTask = nil
        isTransitioning = true
        Task {
            do {
                try await Task.detached { [bridge] in try bridge.stop() }.value
                isRunning = false
                status = [:]
                leaders = []
                UserDefaults.standard.set(false, forKey: "operatorAutoConnect")
                appendSystemEvent("Watcher 已离开 Mesh")
            } catch {
                errorMessage = error.localizedDescription
            }
            isTransitioning = false
        }
    }

    func refresh() {
        Task { await pollOnce(showError: true) }
    }

    func sendMessage(subject: String, body: String, to targetIDs: [String]) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        let targets = leaders.filter { targetIDs.contains($0.id) }
        guard isRunning, !text.isEmpty, !targets.isEmpty else { return }

        let event = OperatorEvent(
            id: UUID(), kind: .message, direction: .outbound,
            title: subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "消息" : subject,
            body: text, createdAt: .now, updatedAt: .now,
            receipts: targets.map { DeliveryReceipt(peerID: $0.id, peerName: $0.name, state: .sending) },
            unread: false
        )
        events.insert(event, at: 0)
        persistHistory()
        isSending = true

        Task {
            for target in targets {
                do {
                    let response = try await meshCall("send", params: [
                        "peer_id": target.id,
                        "kind": "message",
                        "payload": [
                        "protocol": "mesh-watcher/1",
                        "type": "watcher_message",
                        "origin_role": "watcher",
                            "subject": event.title,
                            "text": text,
                            "audience": targets.count > 1 ? "broadcast" : "direct",
                        "watcher_name": nodeName,
                        ],
                        "ttl_seconds": 3600,
                    ])
                    let envelopeID = (response as? [String: Any])?["id"] as? String
                    updateReceipt(eventID: event.id, peerID: target.id, state: .delivered, envelopeID: envelopeID)
                } catch {
                    updateReceipt(eventID: event.id, peerID: target.id, state: .failed, diagnostic: error.localizedDescription)
                }
            }
            isSending = false
        }
    }

    func sendTask(label: String, prompt: String, to peerID: String) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isRunning, !text.isEmpty, let target = leaders.first(where: { $0.id == peerID }) else { return }
        let title = label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "远程任务" : label
        let eventID = UUID()
        events.insert(OperatorEvent(
            id: eventID, kind: .task, direction: .outbound, title: title, body: text,
            createdAt: .now, updatedAt: .now,
            receipts: [DeliveryReceipt(peerID: target.id, peerName: target.name, state: .sending)],
            unread: false
        ), at: 0)
        persistHistory()
        isSending = true

        Task {
            do {
                let response = try await meshCall("send", params: [
                    "peer_id": target.id,
                    "kind": "task",
                    "payload": [
                        "protocol": "dsh-leader/1",
                        "type": "task_start",
                        "label": title,
                        "prompt": text,
                        "workspace_alias": target.workspaces.first ?? "default",
                        "hop_budget": 0,
                        "origin_session_id": "ios-watcher",
                        "origin_role": "watcher",
                    ],
                    "ttl_seconds": 3600,
                ])
                let envelopeID = (response as? [String: Any])?["id"] as? String
                updateReceipt(eventID: eventID, peerID: target.id, state: .delivered, envelopeID: envelopeID)
            } catch {
                updateReceipt(eventID: eventID, peerID: target.id, state: .failed, diagnostic: error.localizedDescription)
            }
            isSending = false
        }
    }

    func createRoom(name: String, description: String, participantIDs: [String]) {
        let selected = leaders.filter { participantIDs.contains($0.id) }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanDescription = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isRunning, !cleanName.isEmpty, !selected.isEmpty else { return }
        Task {
            do {
                let contract: [String: Any] = [
                    "name": cleanName,
                    "description": cleanDescription,
                    "participants": selected.map(\.id),
                    "max_turns": 200,
                    "max_responders_per_turn": min(5, selected.count),
                    "max_message_bytes": 4096,
                    "max_total_messages": 2048,
                ]
                guard let value = try await meshCall("chat.create", params: ["contract": contract]) as? [String: Any],
                      let room = ChatRoom.parse(value) else {
                    throw MeshBridgeError.message("无法解析新群聊")
                }
                upsertRoom(room)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func sendChatMessage(_ body: String, roomID: String) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isRunning, !isSending, !text.isEmpty,
              let existing = rooms.first(where: { $0.id == roomID }), existing.isOpen else { return }
        isSending = true
        Task {
            do {
                guard let value = try await meshCall("chat.post", params: ["room_id": roomID, "body": text]) as? [String: Any],
                      let room = ChatRoom.parse(value),
                      let prompt = room.messages.last else {
                    throw MeshBridgeError.message("无法解析群聊消息")
                }
                upsertRoom(room)
                await broadcastChatPrompt(room, prompt: prompt)
            } catch {
                errorMessage = error.localizedDescription
            }
            isSending = false
        }
    }

    func markRead(_ eventID: UUID) {
        guard let index = events.firstIndex(where: { $0.id == eventID }), events[index].unread else { return }
        events[index].unread = false
        persistHistory()
    }

    func clearHistory() {
        events = []
        persistHistory()
    }

    private func beginPolling() {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollOnce(showError: false)
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func pollOnce(showError: Bool) async {
        guard isRunning else { return }
        do {
            status = (try await meshCall("status")) as? [String: Any] ?? [:]
            let peers = (try await meshCall("peers")) as? [[String: Any]] ?? []
            leaders = peers.compactMap(LeaderPeer.parse).sorted { lhs, rhs in
                if lhs.isResponsive != rhs.isResponsive { return lhs.isResponsive }
                return lhs.rttMilliseconds < rhs.rttMilliseconds
            }
            let inbox = (try await meshCall("inbox.list", params: ["limit": 100])) as? [[String: Any]] ?? []
            for envelope in inbox { await ingest(envelope) }
            let roomValues = (try await meshCall("chat.list")) as? [[String: Any]] ?? []
            rooms = roomValues.compactMap(ChatRoom.parse)
            lastRefresh = .now
        } catch {
            let message = error.localizedDescription
            if message.contains("cannot connect to mesh daemon")
                || message.contains("daemon is not running")
                || message.contains("Mesh node is not running") {
                pollingTask?.cancel()
                pollingTask = nil
                try? await Task.detached { [bridge] in try bridge.stop() }.value
                isRunning = false
                status = [:]
                leaders = []
                if autoConnect { start() }
            } else if showError {
                errorMessage = message
            }
        }
    }

    private func ingest(_ envelope: [String: Any]) async {
        guard let envelopeID = envelope["id"] as? String,
              !processingEnvelopeIDs.contains(envelopeID) else { return }
        processingEnvelopeIDs.insert(envelopeID)
        defer { processingEnvelopeIDs.remove(envelopeID) }

        if events.contains(where: { $0.sourceEnvelopeID == envelopeID }) {
            _ = try? await meshCall("inbox.ack", params: ["id": envelopeID])
            return
        }

        let kind = envelope["kind"] as? String ?? ""
        let fromPeer = envelope["from_peer"] as? String ?? ""
        let peerName = leaders.first(where: { $0.id == fromPeer })?.name ?? shortPeerID(fromPeer)
        let payload = envelope["payload"] as? [String: Any] ?? [:]
        if kind == "message", payload["protocol"] as? String == "mesh-chat/1" {
            if payload["type"] as? String == "chat_reply" {
                do {
                    guard let value = try await meshCall("chat.ingest", params: ["envelope": envelope]) as? [String: Any],
                          let room = ChatRoom.parse(value) else {
                        throw MeshBridgeError.message("无法解析 Leader 发言")
                    }
                    upsertRoom(room)
                } catch {
                    errorMessage = "群聊消息被拒绝：\(error.localizedDescription)"
                }
            }
            _ = try? await meshCall("inbox.ack", params: ["id": envelopeID])
            return
        }
        switch kind {
        case "message":
            let text = Self.text(payload["text"] ?? payload["message"] ?? payload["content"])
            let title = payload["subject"] as? String ?? "来自 \(peerName) 的消息"
            events.insert(OperatorEvent(
                id: UUID(), kind: .message, direction: .inbound, title: title,
                body: text, createdAt: .now, updatedAt: .now,
                receipts: [DeliveryReceipt(peerID: fromPeer, peerName: peerName, state: .delivered)],
                sourceEnvelopeID: envelopeID, unread: true
            ), at: 0)
            persistHistory()
        case "task_result":
            applyTaskResult(envelopeID: envelopeID, correlationID: envelope["correlation_id"] as? String, payload: payload)
        case "task_progress":
            applyTaskProgress(correlationID: envelope["correlation_id"] as? String, payload: payload)
        case "task":
            await rejectTask(envelopeID: envelopeID, fromPeer: fromPeer)
        default:
            break
        }
        _ = try? await meshCall("inbox.ack", params: ["id": envelopeID])
    }

    private func applyTaskResult(envelopeID: String, correlationID: String?, payload: [String: Any]) {
        guard let correlationID,
              let eventIndex = events.firstIndex(where: { event in
                  event.receipts.contains(where: { $0.envelopeID == correlationID })
              }), let receiptIndex = events[eventIndex].receipts.firstIndex(where: { $0.envelopeID == correlationID }) else { return }
        let completed = payload["stop_reason"] as? String == "completed" || payload["type"] as? String == "task_complete"
        events[eventIndex].receipts[receiptIndex].state = completed ? .completed : .failed
        events[eventIndex].receipts[receiptIndex].diagnostic = payload["diagnostic"] as? String
        events[eventIndex].result = Self.text(payload["output"])
        events[eventIndex].sourceEnvelopeID = envelopeID
        events[eventIndex].updatedAt = .now
        events[eventIndex].unread = true
        persistHistory()
    }

    private func applyTaskProgress(correlationID: String?, payload: [String: Any]) {
        guard let correlationID,
              let eventIndex = events.firstIndex(where: { $0.receipts.contains(where: { $0.envelopeID == correlationID }) }),
              let receiptIndex = events[eventIndex].receipts.firstIndex(where: { $0.envelopeID == correlationID }) else { return }
        events[eventIndex].receipts[receiptIndex].state = .running
        let progress = Self.text(payload["message"] ?? payload["output"])
        if !progress.isEmpty { events[eventIndex].result = progress }
        events[eventIndex].updatedAt = .now
        persistHistory()
    }

    private func rejectTask(envelopeID: String, fromPeer: String) async {
        guard !fromPeer.isEmpty else { return }
        _ = try? await meshCall("send", params: [
            "peer_id": fromPeer,
            "kind": "task_result",
            "correlation_id": envelopeID,
            "payload": [
                "protocol": "dsh-leader/1",
                "type": "task_failed",
                "output": [],
                "stop_reason": "error",
                "diagnostic": "This mesh member is an iOS Watcher and does not execute tasks.",
            ],
            "ttl_seconds": 3600,
        ])
    }

    private func updateReceipt(eventID: UUID, peerID: String, state: DeliveryState, envelopeID: String? = nil, diagnostic: String? = nil) {
        guard let eventIndex = events.firstIndex(where: { $0.id == eventID }),
              let receiptIndex = events[eventIndex].receipts.firstIndex(where: { $0.peerID == peerID }) else { return }
        events[eventIndex].receipts[receiptIndex].state = state
        if let envelopeID { events[eventIndex].receipts[receiptIndex].envelopeID = envelopeID }
        if let diagnostic { events[eventIndex].receipts[receiptIndex].diagnostic = diagnostic }
        events[eventIndex].updatedAt = .now
        persistHistory()
    }

    private func appendSystemEvent(_ body: String) {
        events.insert(OperatorEvent(
            id: UUID(), kind: .system, direction: .inbound, title: "网络事件", body: body,
            createdAt: .now, updatedAt: .now, receipts: [], unread: false
        ), at: 0)
        persistHistory()
    }

    private func upsertRoom(_ room: ChatRoom) {
        rooms.removeAll { $0.id == room.id }
        rooms.insert(room, at: 0)
    }

    private func broadcastChatPrompt(_ room: ChatRoom, prompt: ChatMessage) async {
        let known = Dictionary(uniqueKeysWithValues: leaders.map { ($0.id, $0) })
        let recent = room.messages.dropLast().suffix(12).map { message in
            let name = message.authorRole == .watcher
                ? nodeName
                : (known[message.authorPeer]?.name ?? shortPeerID(message.authorPeer))
            return "\(name): \(message.body)"
        }.joined(separator: "\n")
        let contract: [String: Any] = [
            "name": room.name,
            "description": room.description,
            "participants": room.participants,
            "max_turns": room.maxTurns,
            "max_responders_per_turn": room.maxRespondersPerTurn,
            "max_message_bytes": room.maxMessageBytes,
        ]
        let recipients = room.participants.filter { known[$0] != nil }.prefix(room.maxRespondersPerTurn)
        for peerID in recipients {
            do {
                _ = try await meshCall("send", params: [
                    "peer_id": peerID,
                    "kind": "message",
                    "payload": [
                        "protocol": "mesh-chat/1",
                        "type": "chat_prompt",
                        "room_id": room.id,
                        "message_id": prompt.id,
                        "turn": room.turn,
                        "text": prompt.body,
                        "contract": contract,
                        "context": recent,
                        "origin_role": "watcher",
                    ],
                    "ttl_seconds": 3600,
                ])
            } catch {
                errorMessage = "无法向 \(known[peerID]?.name ?? shortPeerID(peerID)) 发送群聊消息：\(error.localizedDescription)"
            }
        }
    }

    private func persistHistory() { historyStore.save(events) }

    private func persistSettings() {
        UserDefaults.standard.set(nodeName, forKey: "operatorName")
        UserDefaults.standard.set(networkID, forKey: "networkID")
    }

    private func meshCall(_ method: String, params: [String: Any] = [:]) async throws -> Any {
        try await Task.detached { [bridge] in try bridge.call(method, params: params) }.value
    }

    private func shortPeerID(_ value: String) -> String {
        value.count > 18 ? "\(value.prefix(8))…\(value.suffix(5))" : (value.isEmpty ? "Unknown peer" : value)
    }

    private static func text(_ value: Any?) -> String {
        if let text = value as? String { return text }
        if let blocks = value as? [[String: Any]] {
            return blocks.compactMap { $0["text"] as? String }.joined(separator: "\n\n")
        }
        return ""
    }

    private static let stateDirectory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent("AgentMesh", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }()
}
