import Foundation

enum MeshBridgeError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self { case .message(let text): text }
    }
}

final class MeshBridge: @unchecked Sendable {
    private let lock = NSLock()
    private var handle: UInt64?

    func start(config: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: config)
        let json = String(decoding: data, as: UTF8.self)
        let response = try json.withCString { try decode(agent_mesh_mobile_start($0)) }
        guard let result = response["result"] as? [String: Any],
              let value = result["handle"] as? NSNumber else {
            throw MeshBridgeError.message("Rust bridge returned no node handle")
        }
        lock.withLock { handle = value.uint64Value }
        return result
    }

    func call(_ method: String, params: [String: Any] = [:]) throws -> Any {
        guard let current = lock.withLock({ handle }) else {
            throw MeshBridgeError.message("Mesh node is not running")
        }
        let data = try JSONSerialization.data(withJSONObject: params)
        let json = String(decoding: data, as: UTF8.self)
        let response = try method.withCString { methodPointer in
            try json.withCString { paramsPointer in
                try decode(agent_mesh_mobile_call(current, methodPointer, paramsPointer))
            }
        }
        return response["result"] ?? NSNull()
    }

    func stop() throws {
        guard let current = lock.withLock({ handle }) else { return }
        defer { lock.withLock { handle = nil } }
        _ = try decode(agent_mesh_mobile_stop(current))
    }

    private func decode(_ pointer: UnsafeMutablePointer<CChar>?) throws -> [String: Any] {
        guard let pointer else {
            throw MeshBridgeError.message("Rust bridge returned an empty response")
        }
        defer { agent_mesh_mobile_string_free(pointer) }
        let data = Data(String(cString: pointer).utf8)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MeshBridgeError.message("Rust bridge returned invalid JSON")
        }
        if object["ok"] as? Bool != true {
            throw MeshBridgeError.message(object["error"] as? String ?? "Unknown mesh error")
        }
        return object
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
