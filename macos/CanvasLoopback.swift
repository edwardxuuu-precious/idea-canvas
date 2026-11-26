import Foundation
import Network
import Security

final class CanvasLoopback: @unchecked Sendable {
    private static let headerLimit = 16 * 1024
    private static let bodyLimit = 12 * 1024 * 1024
    private static let peerLimit = 32
    private static let headerEnd = Data("\r\n\r\n".utf8)

    private let queue = DispatchQueue(label: "IdeaCanvas.loopback")
    private let queueKey = DispatchSpecificKey<Bool>()
    private let listener: NWListener
    private let portNumber: UInt16
    private let rootURL: URL
    private let origin: String
    private let host: String
    private let cookieName: String
    private let session: String
    private let apiToken: String
    private let page: Data
    private let read: @Sendable (String?) throws -> CanvasSyncSnapshot?
    private let write: @Sendable (String, String) throws -> CanvasSyncSnapshot

    private var onState: (@Sendable (Bool) -> Void)?
    private var started = false
    private var stopped = false
    private var ready = false
    private var pairing: (code: String, expires: DispatchTime)?
    private var peers: [ObjectIdentifier: Peer] = [:]

    init(
        port: UInt16,
        page: Data,
        root: URL,
        read: @escaping @Sendable (String?) throws -> CanvasSyncSnapshot?,
        write: @escaping @Sendable (String, String) throws -> CanvasSyncSnapshot
    ) throws {
        guard port != 0, let endpoint = NWEndpoint.Port(rawValue: port) else {
            throw ServiceError.invalidPort
        }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: endpoint)
        parameters.requiredInterfaceType = .loopback
        listener = try NWListener(using: parameters)
        portNumber = port
        rootURL = root
        host = port == 80 ? "127.0.0.1" : "127.0.0.1:\(port)"
        origin = "http://\(host)"
        cookieName = "idea_canvas_\(port)"
        session = Self.hex(try Self.secretKey(named: "browser-session.key", in: root))
        apiToken = Self.hex(try Self.secretKey(named: "local-api.key", in: root))
        self.page = page
        self.read = read
        self.write = write
        queue.setSpecific(key: queueKey, value: true)
    }

    static func isLocalAPIEnabled(in root: URL) -> Bool {
        !FileManager.default.fileExists(atPath: root.appendingPathComponent("local-api.disabled").path)
    }

    func start(onState: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            guard !started, !stopped else {
                onState(ready)
                return
            }
            started = true
            self.onState = onState
            listener.stateUpdateHandler = { [weak self] state in
                guard let self, !self.stopped else { return }
                switch state {
                case .ready:
                    self.ready = true
                    self.onState?(true)
                case .waiting, .failed, .cancelled:
                    self.ready = false
                    self.pairing = nil
                    self.onState?(false)
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self, self.ready, self.peers.count < Self.peerLimit else {
                    connection.cancel()
                    return
                }
                self.accept(connection)
            }
            listener.start(queue: queue)
        }
    }

    func makePairingLink() throws -> URL {
        try onQueue {
            guard ready, !stopped else { throw ServiceError.unavailable }
            let code = Self.hex(try Self.randomBytes(count: 24))
            guard let link = URL(string: "\(origin)/#pair=\(code)") else {
                throw ServiceError.unavailable
            }
            pairing = (code, .now() + .seconds(300))
            return link
        }
    }

    func stop() {
        onQueue {
            guard !stopped else { return }
            stopped = true
            ready = false
            pairing = nil
            listener.cancel()
            for peer in Array(peers.values) {
                close(peer)
            }
            onState?(false)
            onState = nil
        }
    }

    private func onQueue<T>(_ body: () throws -> T) rethrows -> T {
        // Listener callbacks already run on queue and may call public methods.
        if DispatchQueue.getSpecific(key: queueKey) == true { return try body() }
        return try queue.sync(execute: body)
    }

    private func accept(_ connection: NWConnection) {
        let peer = Peer(connection, queue: queue)
        peers[ObjectIdentifier(peer)] = peer
        peer.deadline.schedule(deadline: .now() + .seconds(12))
        peer.deadline.setEventHandler { [weak self, weak peer] in
            if let self, let peer { self.close(peer) }
        }
        peer.deadline.activate()
        connection.start(queue: queue)
        receive(peer)
    }

    private func receive(_ peer: Peer) {
        peer.connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self, weak peer] data, _, ended, error in
            guard let self, let peer, self.peers[ObjectIdentifier(peer)] != nil else { return }
            if error != nil {
                self.close(peer)
                return
            }
            if let data { peer.buffer.append(data) }
            do {
                if peer.request == nil {
                    guard let end = peer.buffer.range(of: Self.headerEnd) else {
                        if peer.buffer.count >= Self.headerLimit { throw Failure.headerTooLarge }
                        if ended { self.close(peer) } else { self.receive(peer) }
                        return
                    }
                    guard end.upperBound <= Self.headerLimit else { throw Failure.headerTooLarge }
                    let head = try Head(peer.buffer[..<end.lowerBound])
                    peer.request = try self.authorize(head)
                    peer.buffer.removeSubrange(peer.buffer.startIndex..<end.upperBound)
                }

                guard let request = peer.request else { throw Failure.badRequest }
                if peer.buffer.count == request.length {
                    let response = try self.respond(to: request.route, body: peer.buffer)
                    self.send(response, to: peer)
                } else if peer.buffer.count > request.length || ended {
                    throw Failure.badRequest
                } else {
                    self.receive(peer)
                }
            } catch let failure as Failure {
                self.send(failure.response, to: peer)
            } catch {
                self.send(Failure.storage.response, to: peer)
            }
        }
    }

    private func close(_ peer: Peer) {
        guard peers.removeValue(forKey: ObjectIdentifier(peer)) != nil else { return }
        peer.deadline.cancel()
        peer.connection.cancel()
    }

    private func send(_ response: Response, to peer: Peer) {
        let contentSecurityPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
        var headers = [
            "HTTP/1.1 \(response.status) \(response.reason)",
            "Connection: close",
            "Cache-Control: no-store",
            "Content-Security-Policy: \(contentSecurityPolicy)",
            "X-Content-Type-Options: nosniff",
            "Referrer-Policy: no-referrer",
            "Cross-Origin-Resource-Policy: same-origin"
        ]
        if response.status != 204 {
            headers.append("Content-Length: \(response.body.count)")
        }
        if let type = response.type { headers.append("Content-Type: \(type)") }
        if let cookie = response.cookie { headers.append("Set-Cookie: \(cookie)") }
        var bytes = Data((headers.joined(separator: "\r\n") + "\r\n\r\n").utf8)
        if !response.headOnly { bytes.append(response.body) }
        peer.connection.send(content: bytes, completion: .contentProcessed { [weak self, weak peer] _ in
            if let self, let peer { self.close(peer) }
        })
    }

    private func authorize(_ head: Head) throws -> Request {
        guard head.headers["host"] == host else { throw Failure.invalidHost }
        switch (head.method, head.target) {
        case ("GET", "/"), ("HEAD", "/"):
            guard head.length == 0 else { throw Failure.badRequest }
            return Request(route: .page(headOnly: head.method == "HEAD"), length: 0)
        case ("POST", "/pair"):
            try authorizeJSON(head)
            guard head.length <= 1024 else { throw Failure.bodyTooLarge }
            return Request(route: .pair, length: head.length)
        case ("GET", "/api/agent/health"):
            guard head.length == 0 else { throw Failure.badRequest }
            guard authenticatedAgent(head) else { throw Failure.unauthorized }
            return Request(route: .agentHealth, length: 0)
        case ("PUT", "/api/state"):
            if authenticatedAgent(head) {
                try validateJSONPayload(head)
                return Request(route: .write, length: head.length)
            }
            if head.headers["origin"] == nil && head.headers["authorization"] != nil {
                throw Failure.unauthorized
            }
            try authorizeJSON(head)
            guard authenticated(head.headers["cookie"]) else { throw Failure.unauthorized }
            return Request(route: .write, length: head.length)
        case ("GET", "/api/state"):
            return try authorizeRead(head, since: nil)
        case ("GET", let target) where target.hasPrefix("/api/state?since="):
            let encoded = String(target.dropFirst("/api/state?since=".count))
            guard let since = encoded.removingPercentEncoding, Self.validRevision(since) else {
                throw Failure.badRequest
            }
            return try authorizeRead(head, since: since)
        default:
            throw Failure.notFound
        }
    }

    private func authorizeRead(_ head: Head, since: String?) throws -> Request {
        guard head.length == 0 else { throw Failure.badRequest }
        if authenticatedAgent(head) {
            return Request(route: .read(since), length: 0)
        }
        guard authenticated(head.headers["cookie"]) else { throw Failure.unauthorized }
        if let requestOrigin = head.headers["origin"], requestOrigin != origin {
            throw Failure.invalidOrigin
        }
        return Request(route: .read(since), length: 0)
    }

    private func authorizeJSON(_ head: Head) throws {
        guard head.headers["origin"] == origin else { throw Failure.invalidOrigin }
        try validateJSONPayload(head)
    }

    private func validateJSONPayload(_ head: Head) throws {
        let mediaType = head.headers["content-type"]?
            .split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
            .first?.trimmingCharacters(in: .whitespaces).lowercased()
        guard mediaType == "application/json" else { throw Failure.invalidMediaType }
        guard head.length > 0 else { throw Failure.badRequest }
    }

    private func respond(to route: Route, body: Data) throws -> Response {
        switch route {
        case .page(let headOnly):
            return Response(
                status: 200, reason: "OK", type: "text/html; charset=utf-8",
                body: page, headOnly: headOnly
            )
        case .pair:
            guard let request = try? JSONDecoder().decode(PairBody.self, from: body) else {
                throw Failure.badRequest
            }
            guard let pairing, pairing.expires > .now(),
                  Self.matches(request.code, pairing.code) else {
                throw Failure.invalidPairing
            }
            self.pairing = nil
            return Response(
                status: 204, reason: "No Content",
                cookie: "\(cookieName)=\(session); HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000"
            )
        case .agentHealth:
            return try Response.json(
                200, "OK",
                AgentHealth(ok: true, port: portNumber, pid: ProcessInfo.processInfo.processIdentifier)
            )
        case .read(let since):
            guard let snapshot = try read(since) else {
                return Response(status: 204, reason: "No Content")
            }
            return try Response.json(200, "OK", snapshot)
        case .write:
            guard let request = try? JSONDecoder().decode(WriteBody.self, from: body),
                  Self.validRevision(request.expectedRevision),
                  let inner = try? JSONSerialization.jsonObject(with: Data(request.json.utf8)),
                  inner is [String: Any] else {
                throw Failure.invalidSnapshot
            }
            do {
                let snapshot = try write(request.expectedRevision, request.json)
                return try Response.json(200, "OK", snapshot)
            } catch let conflict as CanvasSyncConflict {
                return try Response.json(409, "Conflict", conflict.snapshot)
            } catch let validation as CanvasValidationError {
                return try Response.json(400, "Bad Request", ["error": "invalid_snapshot", "message": validation.message])
            } catch is DecodingError {
                throw Failure.invalidSnapshot
            }
        }
    }

    private func authenticatedAgent(_ head: Head) -> Bool {
        guard head.headers["origin"] == nil, Self.isLocalAPIEnabled(in: rootURL),
              let authorization = head.headers["authorization"] else { return false }
        let parts = authorization.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].lowercased() == "bearer" else { return false }
        return Self.matches(String(parts[1]).trimmingCharacters(in: .whitespaces), apiToken)
    }

    private func authenticated(_ cookie: String?) -> Bool {
        guard let cookie else { return false }
        var token: String?
        for part in cookie.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2,
                  pair[0].trimmingCharacters(in: .whitespaces) == cookieName else { continue }
            guard token == nil else { return false }
            token = String(pair[1])
        }
        guard let token else { return false }
        return Self.matches(token, session)
    }

    private static func validRevision(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
                || byte == 45 || byte == 95
        }
    }

    private static func matches(_ offered: String, _ secret: String) -> Bool {
        guard offered.utf8.count == secret.utf8.count else { return false }
        return zip(offered.utf8, secret.utf8).reduce(UInt8(0)) { difference, pair in
            difference | (pair.0 ^ pair.1)
        } == 0
    }

    private static func secretKey(named name: String, in root: URL) throws -> Data {
        let manager = FileManager.default
        let secretFile = root.appendingPathComponent(name)
        try manager.createDirectory(
            at: root, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        func load() throws -> Data {
            let attributes = try manager.attributesOfItem(atPath: secretFile.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  let mode = attributes[.posixPermissions] as? Int, mode & 0o077 == 0,
                  attributes[.size] as? Int == 32 else {
                throw ServiceError.sessionKey
            }
            let key = try Data(contentsOf: secretFile)
            guard key.count == 32 else { throw ServiceError.sessionKey }
            return key
        }

        do {
            return try load()
        } catch let error as NSError where error.domain == NSCocoaErrorDomain
            && [NSFileReadNoSuchFileError, NSFileNoSuchFileError].contains(error.code) {
            // Publish a complete, private key without replacing a concurrent creator's key.
            let staging = root.appendingPathComponent(".\(name)-\(UUID().uuidString)", isDirectory: true)
            try manager.createDirectory(
                at: staging, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            defer { try? manager.removeItem(at: staging) }
            let candidate = staging.appendingPathComponent("key")
            let key = try randomBytes(count: 32)
            try key.write(to: candidate, options: .withoutOverwriting)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: candidate.path)
            do {
                try manager.linkItem(at: candidate, to: secretFile)
                return key
            } catch {
                return try load()
            }
        }
    }

    private static func randomBytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
            throw ServiceError.random
        }
        return Data(bytes)
    }

    private static func hex(_ bytes: Data) -> String {
        bytes.map { String(format: "%02x", Int($0)) }.joined()
    }

    private enum ServiceError: LocalizedError {
        case invalidPort, unavailable, sessionKey, random

        var errorDescription: String? {
            switch self {
            case .invalidPort: "画布同步端口无效。"
            case .unavailable: "本机画布服务尚未就绪。"
            case .sessionKey: "无法读取安全的本机浏览器配对密钥。"
            case .random: "无法生成本机浏览器配对密钥。"
            }
        }
    }

    private final class Peer: @unchecked Sendable {
        let connection: NWConnection
        let deadline: DispatchSourceTimer
        var buffer = Data()
        var request: Request?

        init(_ connection: NWConnection, queue: DispatchQueue) {
            self.connection = connection
            deadline = DispatchSource.makeTimerSource(queue: queue)
        }
    }

    private enum Route {
        case page(headOnly: Bool), pair, agentHealth, read(String?), write
    }

    private struct Request {
        let route: Route
        let length: Int
    }

    private struct Head {
        let method: String
        let target: String
        let headers: [String: String]
        let length: Int

        init(_ bytes: Data) throws {
            let fields = String(decoding: bytes, as: UTF8.self).components(separatedBy: "\r\n")
            let start = fields[0].split(separator: " ", omittingEmptySubsequences: false)
            guard start.count == 3, start[2] == "HTTP/1.1",
                  Self.token(start[0]), start[1].first == "/", !start[1].hasPrefix("//"),
                  !start[1].contains("#"), start[1].utf8.allSatisfy({ (33...126).contains($0) }) else {
                throw Failure.badRequest
            }

            let critical: Set<String> = ["host", "origin", "cookie", "authorization", "content-type",
                                         "content-length", "transfer-encoding", "expect"]
            var headers: [String: String] = [:]
            for line in fields.dropFirst() {
                guard let delimiter = line.firstIndex(of: ":"), Self.token(line[..<delimiter]) else {
                    throw Failure.badRequest
                }
                let name = line[..<delimiter].lowercased()
                guard critical.contains(name) else { continue }
                let value = line[line.index(after: delimiter)...]
                if name == "cookie" {
                    guard value.utf8.allSatisfy({ $0 == 9 || $0 >= 32 && $0 != 127 }) else {
                        throw Failure.badRequest
                    }
                } else {
                    guard value.utf8.allSatisfy({ $0 == 9 || (32...126).contains($0) }) else {
                        throw Failure.badRequest
                    }
                }
                guard headers[name] == nil else { throw Failure.badRequest }
                headers[name] = value.trimmingCharacters(in: .whitespaces)
            }

            guard headers["transfer-encoding"] == nil else { throw Failure.badRequest }
            guard headers["expect"] == nil else { throw Failure.unsupportedExpectation }
            let length = headers["content-length"] ?? "0"
            guard !length.isEmpty, length.utf8.allSatisfy({ (48...57).contains($0) }) else {
                throw Failure.badRequest
            }
            guard let byteCount = Int(length), byteCount <= CanvasLoopback.bodyLimit else {
                throw Failure.bodyTooLarge
            }
            method = String(start[0])
            target = String(start[1])
            self.headers = headers
            self.length = byteCount
        }

        private static func token(_ value: Substring) -> Bool {
            let punctuation = "!#$%&'*+-.^`_|~".utf8
            return !value.isEmpty && value.utf8.allSatisfy { byte in
                (48...57).contains(byte) || (65...90).contains(byte)
                    || (97...122).contains(byte) || punctuation.contains(byte)
            }
        }
    }

    private struct PairBody: Decodable {
        let code: String
    }

    private struct WriteBody: Decodable {
        let expectedRevision: String
        let json: String
    }

    private struct AgentHealth: Encodable {
        let ok: Bool
        let port: UInt16
        let pid: Int32
    }

    private struct Response {
        let status: Int
        let reason: String
        var type: String?
        var body = Data()
        var cookie: String?
        var headOnly = false

        static func json<T: Encodable>(_ status: Int, _ reason: String, _ data: T) throws -> Self {
            Response(
                status: status, reason: reason, type: "application/json; charset=utf-8",
                body: try JSONEncoder().encode(data)
            )
        }
    }

    private enum Failure: Error {
        case badRequest, invalidHost, invalidOrigin, unauthorized, invalidPairing, notFound
        case bodyTooLarge, headerTooLarge, invalidMediaType, unsupportedExpectation
        case invalidSnapshot, storage

        var response: Response {
            let (status, reason, code, message): (Int, String, String, String)
            switch self {
            case .badRequest:
                (status, reason, code, message) = (400, "Bad Request", "bad_request", "请求格式无效。")
            case .invalidHost:
                (status, reason, code, message) = (400, "Bad Request", "invalid_host", "请使用画布提供的本机地址。")
            case .invalidOrigin:
                (status, reason, code, message) = (403, "Forbidden", "invalid_origin", "请在画布页面内发送此请求。")
            case .unauthorized:
                (status, reason, code, message) = (401, "Unauthorized", "unauthorized", "请先使用桌面应用中的链接配对。")
            case .invalidPairing:
                (status, reason, code, message) = (401, "Unauthorized", "invalid_pairing", "配对链接已过期或已使用，请生成新链接。")
            case .notFound:
                (status, reason, code, message) = (404, "Not Found", "not_found", "未找到请求的画布资源。")
            case .bodyTooLarge:
                (status, reason, code, message) = (413, "Content Too Large", "too_large", "画布超出本机同步的大小限制。")
            case .headerTooLarge:
                (status, reason, code, message) = (431, "Request Header Fields Too Large", "header_too_large", "请求头过长。")
            case .invalidMediaType:
                (status, reason, code, message) = (415, "Unsupported Media Type", "invalid_type", "请以 JSON 格式提交。")
            case .unsupportedExpectation:
                (status, reason, code, message) = (417, "Expectation Failed", "invalid_expectation", "不支持此 HTTP 请求选项。")
            case .invalidSnapshot:
                (status, reason, code, message) = (400, "Bad Request", "invalid_snapshot", "画布数据格式无效。")
            case .storage:
                (status, reason, code, message) = (500, "Internal Server Error", "storage_error", "无法读写本机画布数据。")
            }
            return (try? Response.json(status, reason, ["error": code, "message": message]))
                ?? Response(status: status, reason: reason)
        }
    }
}
