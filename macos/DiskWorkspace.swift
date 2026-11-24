import CryptoKit
import Darwin
import Foundation

struct CanvasSyncSnapshot: Codable, Sendable {
    let revision: String
    let json: String?

    private enum CodingKeys: String, CodingKey { case revision, json }

    func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(revision, forKey: .revision)
        try fields.encode(json, forKey: .json)
    }

    fileprivate static let empty = CanvasSyncSnapshot(revision: "empty", json: nil)
}

struct CanvasSyncConflict: LocalizedError, Sendable {
    let snapshot: CanvasSyncSnapshot

    var errorDescription: String? { "画布已在其他窗口更新。" }
}

private struct DiskWorkspaceError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

private func diskError(_ operation: String, _ code: Int32 = errno) -> DiskWorkspaceError {
    DiskWorkspaceError("\(operation)（\(String(cString: strerror(code)))）。")
}

private struct DiskSnapshot {
    enum Tone: String, Decodable { case topic, idea, question, action, reference }
    enum EdgeKind: String, Decodable { case branch, link }

    struct Card: Decodable, Equatable {
        let id: String
        let x, y, w, h: Double
        let tone: Tone
        let title, body: String
        let richBody: String?
    }

    struct Edge: Decodable, Equatable {
        let id, from, to, label: String
        let kind: EdgeKind
    }

    struct View: Decodable {
        let x, y, scale: Double
    }

    struct Board: Decodable {
        let id, name: String
        let nodes: [Card]
        let edges: [Edge]
        let view: View?

        private enum CodingKeys: String, CodingKey { case id, name, nodes, edges, view }

        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            id = try fields.decode(String.self, forKey: .id)
            name = try fields.decode(String.self, forKey: .name)
            nodes = try fields.decode([Card].self, forKey: .nodes)
            edges = try fields.decode([Edge].self, forKey: .edges)
            view = try fields.decode(View?.self, forKey: .view)
        }

        func sameContent(as other: Board) -> Bool {
            id == other.id && name == other.name && nodes == other.nodes && edges == other.edges
        }
    }

    struct Workspace: Decodable {
        let version: Int
        let activeId: String
        let boards: [Board]
    }

    let bytes: Data
    let json: String
    let workspace: Workspace
    let syncSnapshot: CanvasSyncSnapshot

    init(_ bytes: Data) throws {
        guard let json = String(data: bytes, encoding: .utf8), !json.hasPrefix("\u{feff}") else {
            throw DiskWorkspaceError("画布数据必须是 UTF-8 编码的 JSON。")
        }
        let workspace: Workspace
        do {
            workspace = try JSONDecoder().decode(Workspace.self, from: bytes)
        } catch {
            throw DiskWorkspaceError("画布 JSON 损坏或缺少必要字段。")
        }
        guard workspace.version == 1 || workspace.version == 2 else {
            throw DiskWorkspaceError("无法读取此版本的画布数据。")
        }
        var boardIDs = Set<String>()
        for board in workspace.boards {
            guard Self.validID(board.id), boardIDs.insert(board.id).inserted else {
                throw DiskWorkspaceError("画布标识无效或重复。")
            }
            if let view = board.view {
                guard Self.validCoordinate(view.x), Self.validCoordinate(view.y), (0.08...3).contains(view.scale) else {
                    throw DiskWorkspaceError("画布视图的位置或缩放比例无效。")
                }
            }
            var cardIDs = Set<String>()
            for card in board.nodes {
                guard Self.validID(card.id), cardIDs.insert(card.id).inserted else {
                    throw DiskWorkspaceError("卡片标识无效或重复。")
                }
                guard Self.validCoordinate(card.x), Self.validCoordinate(card.y),
                      (64...1_000_000).contains(card.w), (36...1_000_000).contains(card.h) else {
                    throw DiskWorkspaceError("卡片位置或尺寸无效。")
                }
            }
            var edgeIDs = Set<String>()
            var pairs = Set<String>()
            for edge in board.edges {
                guard Self.validID(edge.id), edgeIDs.insert(edge.id).inserted else {
                    throw DiskWorkspaceError("连线标识无效或重复。")
                }
                guard cardIDs.contains(edge.from), cardIDs.contains(edge.to), edge.from != edge.to else {
                    throw DiskWorkspaceError("连线必须连接两张不同的卡片。")
                }
                let pair = edge.from < edge.to ? "\(edge.from):\(edge.to)" : "\(edge.to):\(edge.from)"
                guard pairs.insert(pair).inserted else { throw DiskWorkspaceError("两张卡片间的连线重复。") }
            }
        }
        guard boardIDs.contains(workspace.activeId) else { throw DiskWorkspaceError("找不到当前画布。") }
        self.bytes = bytes
        self.json = json
        self.workspace = workspace
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        syncSnapshot = CanvasSyncSnapshot(revision: "sha256-\(digest)", json: json)
    }

    private static func validID(_ id: String) -> Bool {
        (1...128).contains(id.utf8.count) && id.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }

    private static func validCoordinate(_ value: Double) -> Bool {
        (-1_000_000_000...1_000_000_000).contains(value)
    }

    func sameContent(as other: DiskSnapshot) -> Bool {
        let boards = workspace.boards
        let previous = other.workspace.boards
        return boards.count == previous.count && zip(boards, previous).allSatisfy { $0.sameContent(as: $1) }
    }

    func deletesContent(from earlier: DiskSnapshot) -> Bool {
        let current = Dictionary(uniqueKeysWithValues: workspace.boards.map { ($0.id, $0) })
        return earlier.workspace.boards.contains { oldBoard in
            guard let newBoard = current[oldBoard.id] else { return true }
            let cardIDs = Set(newBoard.nodes.map(\.id))
            let edgeIDs = Set(newBoard.edges.map(\.id))
            return oldBoard.nodes.contains { !cardIDs.contains($0.id) } || oldBoard.edges.contains { !edgeIDs.contains($0.id) }
        }
    }
}

final class DiskWorkspace: @unchecked Sendable {
    let root: URL
    let file: URL
    let backups: URL

    private enum Baseline {
        case unread
        case loaded(DiskSnapshot?)
    }

    private let directory: Int32
    private let backupDirectory: Int32
    private let stateLock = NSLock()
    private var baseline = Baseline.unread
    private var lastDailyBackup: String?

    init(root: URL) throws {
        let root = root.standardizedFileURL
        let backups = root.appendingPathComponent("历史备份", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            throw DiskWorkspaceError("无法创建画布数据文件夹（\(error.localizedDescription)）。")
        }
        let directory = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw diskError("无法打开画布数据文件夹") }
        let backupDirectory: Int32
        do {
            guard flock(directory, LOCK_EX | LOCK_NB) == 0 else {
                if errno == EWOULDBLOCK { throw DiskWorkspaceError("画布数据已由另一窗口打开。请关闭该窗口后重试。") }
                throw diskError("无法锁定画布数据文件夹")
            }
            try Self.secureDirectory(directory)
            if mkdirat(directory, backups.lastPathComponent, 0o700) != 0 && errno != EEXIST {
                throw diskError("无法创建历史备份文件夹")
            }
            backupDirectory = openat(directory, backups.lastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard backupDirectory >= 0 else { throw diskError("无法打开历史备份文件夹") }
            do {
                try Self.secureDirectory(backupDirectory)
                try Self.sync(directory)
            } catch {
                close(backupDirectory)
                throw error
            }
        } catch {
            close(directory)
            throw error
        }
        self.root = root
        file = root.appendingPathComponent("画布数据.json")
        self.backups = backups
        self.directory = directory
        self.backupDirectory = backupDirectory
    }

    deinit {
        close(backupDirectory)
        close(directory)
    }

    func initialJSON() throws -> String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        if case let .loaded(snapshot) = baseline { return snapshot?.json }
        let snapshot: DiskSnapshot?
        if let bytes = try Self.read(file.lastPathComponent, from: directory) {
            do {
                snapshot = try DiskSnapshot(bytes)
            } catch {
                throw DiskWorkspaceError("现有画布数据无法加载。\(error.localizedDescription)")
            }
        } else {
            let files = try FileManager.default.contentsOfDirectory(atPath: backups.path)
            guard !files.contains(where: { $0.hasSuffix(".json") }) else {
                throw DiskWorkspaceError("主数据文件缺失。可通过「文件」打开历史备份。")
            }
            snapshot = nil
        }
        baseline = .loaded(snapshot)
        return snapshot?.json
    }

    func save(_ json: String) throws {
        _ = try write(json, expectedRevision: nil)
    }

    func snapshot(since revision: String? = nil) throws -> CanvasSyncSnapshot? {
        stateLock.lock()
        defer { stateLock.unlock() }
        let previous = try checkedBaseline()
        let current = previous?.syncSnapshot ?? .empty
        return current.revision == revision ? nil : current
    }

    func saveSynced(_ json: String, expectedRevision: String) throws -> CanvasSyncSnapshot {
        try write(json, expectedRevision: expectedRevision)
    }

    private func checkedBaseline() throws -> DiskSnapshot? {
        guard case let .loaded(previous) = baseline else { throw DiskWorkspaceError("请先读取现有画布数据。") }
        try requireUnchanged(previous)
        return previous
    }

    private func write(_ json: String, expectedRevision: String?) throws -> CanvasSyncSnapshot {
        stateLock.lock()
        defer { stateLock.unlock() }
        let previous = try checkedBaseline()
        let current = previous?.syncSnapshot ?? .empty
        let bytes = Data(json.utf8)
        if bytes == previous?.bytes {
            try Self.sync(directory)
            return current
        }
        if let expectedRevision, current.revision != expectedRevision {
            throw CanvasSyncConflict(snapshot: current)
        }
        let next = try DiskSnapshot(bytes)
        if previous?.workspace.version == 2 && next.workspace.version == 1 {
            throw DiskWorkspaceError("请刷新浏览器页面，再同步这份画布。")
        }
        if let previous, !next.sameContent(as: previous) {
            try preserveHistory(previous, beforeDeletion: next.deletesContent(from: previous))
        }
        let name = file.lastPathComponent
        try Self.withStagedFile(next.bytes, in: directory) { temp in
            try requireUnchanged(previous)
            if previous == nil {
                guard renameatx_np(directory, temp, directory, name, UInt32(RENAME_EXCL)) == 0 else {
                    throw diskError("无法创建画布数据文件")
                }
            } else if renameat(directory, temp, directory, name) != 0 {
                throw diskError("无法更新画布数据文件")
            }
            baseline = .loaded(next)
            try Self.sync(directory)
        }
        return next.syncSnapshot
    }

    private func requireUnchanged(_ previous: DiskSnapshot?) throws {
        let current = try Self.read(file.lastPathComponent, from: directory)
        guard current == previous?.bytes else {
            throw DiskWorkspaceError("磁盘上的画布数据已在应用外修改。请保留两份内容并重新打开画布。")
        }
    }

    private func preserveHistory(_ previous: DiskSnapshot, beforeDeletion: Bool) throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "yyyy-MM-dd"
        let day = formatter.string(from: Date())
        if lastDailyBackup != day {
            let name = "每日-\(day).json"
            if let existing = try Self.read(name, from: backupDirectory) {
                do { _ = try DiskSnapshot(existing) }
                catch { throw DiskWorkspaceError("今日的历史备份无法验证。\(error.localizedDescription)") }
                try Self.sync(backupDirectory)
            } else {
                try addBackup(previous.bytes, name: name)
            }
            lastDailyBackup = day
        }
        if beforeDeletion {
            try addBackup(previous.bytes, name: "删除前-\(day)-\(UUID().uuidString).json")
        }
    }

    private func addBackup(_ bytes: Data, name: String) throws {
        try Self.withStagedFile(bytes, in: backupDirectory) { temp in
            guard renameatx_np(backupDirectory, temp, backupDirectory, name, UInt32(RENAME_EXCL)) == 0 else {
                throw diskError("无法保留历史备份")
            }
            try Self.sync(backupDirectory)
        }
    }

    private static func secureDirectory(_ descriptor: Int32) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else { throw diskError("无法检查文件夹权限") }
        guard metadata.st_uid == geteuid() else { throw DiskWorkspaceError("画布文件夹必须归当前用户所有。") }
        guard fchmod(descriptor, 0o700) == 0 else { throw diskError("无法限制画布文件夹权限") }
    }

    private static func read(_ name: String, from directory: Int32) throws -> Data? {
        let descriptor = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0 {
            if errno == ENOENT { return nil }
            throw diskError("无法安全读取\(name)")
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else { throw diskError("无法检查\(name)") }
        guard (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_uid == geteuid(), metadata.st_nlink == 1 else {
            throw DiskWorkspaceError("\(name)必须是当前用户拥有的普通文件，且不能是链接。")
        }
        do { return try handle.readToEnd() ?? Data() }
        catch { throw DiskWorkspaceError("读取\(name)失败（\(error.localizedDescription)）。") }
    }

    private static func withStagedFile(_ bytes: Data, in directory: Int32, publish: (String) throws -> Void) throws {
        let temp = ".写入-\(UUID().uuidString).tmp"
        let descriptor = openat(directory, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw diskError("无法创建临时数据文件") }
        defer {
            close(descriptor)
            unlinkat(directory, temp, 0)
        }
        try bytes.withUnsafeBytes { buffer in
            guard var address = buffer.baseAddress else { return }
            var left = buffer.count
            while left > 0 {
                let count = Darwin.write(descriptor, address, left)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw diskError("无法写入画布数据", count == 0 ? EIO : errno) }
                address = address.advanced(by: count)
                left -= count
            }
        }
        try sync(descriptor)
        try publish(temp)
    }

    private static func sync(_ descriptor: Int32) throws {
        while fsync(descriptor) != 0 {
            if errno != EINTR { throw diskError("无法同步画布数据到磁盘") }
        }
    }
}
