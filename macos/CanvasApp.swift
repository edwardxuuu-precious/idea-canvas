import AppKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class CanvasApplication: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    private let dataRoot: URL
    private let fileQueue = DispatchQueue(label: "idea-canvas.file")
    private var store: DiskWorkspace?
    private var syncServer: CanvasLoopback?
    private var syncReady = false
    private let syncPort: UInt16 = 47471
    private var window: NSWindow?
    private var webView: WKWebView?
    private var layoutURL: URL?
    private var terminationPending = false
    private var approvedToQuit = false
    private var openedLayout = false

    init(dataRoot: URL) {
        self.dataRoot = dataRoot
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()
        guard let layoutURL = Bundle.main.url(forResource: "Canvas", withExtension: "html") else {
            stopLaunching(message: "找不到画布页面。")
            return
        }
        self.layoutURL = layoutURL
        let store: DiskWorkspace
        do {
            store = try DiskWorkspace(root: dataRoot)
            self.store = store
        } catch {
            stopLaunching(message: error.localizedDescription)
            return
        }

        var start: [String: Any] = [:]
        do {
            _ = try store.initialJSON()
            if let snapshot = try store.snapshot() {
                start["revision"] = snapshot.revision
                start["json"] = snapshot.json as Any? ?? NSNull()
            }
            beginBrowserSync(layoutURL: layoutURL, store: store)
        } catch {
            start["warning"] = error.localizedDescription
        }

        do {
            let data = try JSONSerialization.data(withJSONObject: start)
            let argument = String(decoding: data, as: UTF8.self)
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let controller = configuration.userContentController
            controller.addScriptMessageHandler(self, contentWorld: .page, name: "ideaCanvas")
            controller.addUserScript(WKUserScript(
                source: "window.ideaCanvasDesktop = Object.freeze(" + argument + ");",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))

            let webView = WKWebView(frame: .zero, configuration: configuration)
            webView.navigationDelegate = self
            webView.uiDelegate = self
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1270, height: 810),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered, defer: false
            )
            window.title = "想法画布"
            window.minSize = NSSize(width: 510, height: 395)
            window.delegate = self
            window.contentView = webView
            window.center()
            self.window = window
            self.webView = webView
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            webView.loadFileURL(layoutURL, allowingReadAccessTo: layoutURL)
        } catch {
            stopLaunching(message: error.localizedDescription)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        syncServer?.stop()
    }

    private func beginBrowserSync(layoutURL: URL, store: DiskWorkspace) {
        do {
            let html = try String(contentsOf: layoutURL, encoding: .utf8)
            let page = html.replacingOccurrences(of: "<!-- LOCAL_CANVAS_SYNC -->", with: #"<meta id="canvas-browser-sync">"#)
            let server = try CanvasLoopback(
                port: syncPort, page: Data(page.utf8), root: dataRoot,
                read: { try store.snapshot(since: $0) },
                write: { try store.saveSynced($1, expectedRevision: $0) }
            )
            syncServer = server
            server.start { [weak self] ready in
                Task { @MainActor [weak self] in self?.syncReady = ready }
            }
        } catch {
            syncReady = false
        }
    }

    @objc private func copySyncLink() {
        guard let window else { return }
        let alert = NSAlert()
        do {
            guard syncReady, let server = syncServer else {
                alert.messageText = "暂时无法连接浏览器"
                alert.informativeText = "请检查本机画布能正常保存，再退出并重新打开桌面版。"
                alert.addButton(withTitle: "确定")
                alert.beginSheetModal(for: window, completionHandler: nil)
                return
            }
            let link = try server.makePairingLink()
            let clipboard = NSPasteboard.general
            clipboard.clearContents()
            clipboard.setString(link.absoluteString, forType: .string)
            alert.messageText = "已复制浏览器同步链接"
            alert.informativeText = "把链接粘贴到 GPT 内嵌浏览器的地址栏。首次连接后，这台 Mac 上的两个入口会读写同一份画布。链接仅可使用一次。"
        } catch {
            alert.messageText = "暂时无法复制同步链接"
            alert.informativeText = error.localizedDescription
        }
        alert.addButton(withTitle: "确定")
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    private static func snapshotObject(_ snapshot: CanvasSyncSnapshot) -> [String: Any] {
        ["revision": snapshot.revision, "json": snapshot.json as Any? ?? NSNull()]
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !approvedToQuit, let webView, let window else { return .terminateNow }
        guard !terminationPending else { return .terminateCancel }
        terminationPending = true
        Task { [weak self] in
            guard let self else { return }
            let saved = try? await webView.callAsyncJavaScript(
                "return window.ideaCanvasBeforeQuit ? await window.ideaCanvasBeforeQuit() : true;",
                arguments: [:], in: nil, contentWorld: .page
            )
            if saved as? Bool == true {
                self.approvedToQuit = true
                sender.terminate(nil)
                return
            }
            let alert = NSAlert()
            alert.messageText = "还有内容未写入本机"
            alert.informativeText = "返回画布可导出可编辑 HTML。"
            alert.addButton(withTitle: "返回画布")
            alert.addButton(withTitle: "退出")
            alert.beginSheetModal(for: window) { response in
                self.terminationPending = false
                if response == .alertSecondButtonReturn {
                    self.approvedToQuit = true
                    sender.terminate(nil)
                }
            }
        }
        // Let WebKit and its save reply run in the normal event loop before quitting.
        return .terminateCancel
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.webView === webView, message.frameInfo.isMainFrame,
            let body = message.body as? [String: Any], let operation = body["operation"] as? String else {
            replyHandler(nil, "无法处理此操作。")
            return
        }
        switch operation {
        case "sync-state", "save":
            guard let store else {
                replyHandler(nil, "画布数据无法读取。")
                return
            }
            let since = body["since"] as? String
            let expected = body["expectedRevision"] as? String
            let json = body["json"] as? String
            fileQueue.async {
                do {
                    let snapshot: CanvasSyncSnapshot?
                    if operation == "sync-state" {
                        snapshot = try store.snapshot(since: since)
                    } else if let json, let expected {
                        snapshot = try store.saveSynced(json, expectedRevision: expected)
                    } else {
                        DispatchQueue.main.async { replyHandler(nil, "画布数据无法读取。") }
                        return
                    }
                    DispatchQueue.main.async {
                        replyHandler(snapshot.map(Self.snapshotObject) as Any? ?? NSNull(), nil)
                    }
                } catch let conflict as CanvasSyncConflict {
                    DispatchQueue.main.async {
                        replyHandler(["conflict": Self.snapshotObject(conflict.snapshot)], nil)
                    }
                } catch {
                    let detail = error.localizedDescription
                    DispatchQueue.main.async { replyHandler(nil, detail) }
                }
            }
        case "sync-link":
            copySyncLink()
            replyHandler(true, nil)
        case "export":
            export(body, replyHandler: replyHandler)
        case "data-folder":
            openDataFolder()
            replyHandler(true, nil)
        case "backups-folder":
            openBackupsFolder()
            replyHandler(true, nil)
        default:
            replyHandler(nil, "无法识别此操作。")
        }
    }

    private func export(_ body: [String: Any], replyHandler: @escaping (Any?, String?) -> Void) {
        guard let window, let kind = body["kind"] as? String, ["html", "json"].contains(kind),
            let filename = body["filename"] as? String, let contents = body["contents"] as? String else {
            replyHandler(nil, "导出数据无法读取。")
            return
        }
        let panel = NSSavePanel()
        panel.title = kind == "html" ? "导出可编辑 HTML" : "导出 JSON"
        panel.allowedContentTypes = [kind == "html" ? .html : .json]
        panel.nameFieldStringValue = URL(fileURLWithPath: filename).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [fileQueue, store] response in
            guard response == .OK, let destination = panel.url else {
                replyHandler(false, nil)
                return
            }
            let outputPath = destination.resolvingSymlinksInPath().path
            if let store, outputPath == store.file.resolvingSymlinksInPath().path ||
                outputPath.hasPrefix(store.backups.resolvingSymlinksInPath().path + "/") {
                replyHandler(nil, "请选择数据文件和历史备份之外的位置。")
                return
            }
            fileQueue.async {
                do {
                    try Data(contents.utf8).write(to: destination, options: .atomic)
                    DispatchQueue.main.async { replyHandler(true, nil) }
                } catch {
                    let detail = error.localizedDescription
                    DispatchQueue.main.async { replyHandler(nil, detail) }
                }
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let requested = navigationAction.request.url?.resolvingSymlinksInPath().standardizedFileURL
        guard !openedLayout, requested == layoutURL?.resolvingSymlinksInPath().standardizedFileURL else {
            decisionHandler(.cancel)
            return
        }
        openedLayout = true
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard let window, frame.isMainFrame else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        let selectingImages = parameters.allowsMultipleSelection
        panel.title = selectingImages ? "插入图片" : "导入 JSON 画布"
        panel.allowedContentTypes = selectingImages ? [.png, .jpeg, .webP, .gif] : [.json]
        panel.allowsMultipleSelection = selectingImages
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        guard let window, frame.isMainFrame else {
            completionHandler(false)
            return
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "取消")
        alert.addButton(withTitle: "删除")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertSecondButtonReturn) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        self.webView = nil
        stopLaunching(message: "画布窗口意外关闭。重新打开桌面入口可以读取已保存到本机的内容。")
    }

    @objc private func openDataFolder() {
        NSWorkspace.shared.open(dataRoot)
    }

    @objc private func openBackupsFolder() {
        if let backups = store?.backups { NSWorkspace.shared.open(backups) }
    }

    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "想法画布")
        appMenu.addItem(withTitle: "退出想法画布", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let fileItem = NSMenuItem()
        let file = NSMenu(title: "文件")
        file.addItem(withTitle: "复制浏览器同步链接", action: #selector(copySyncLink), keyEquivalent: "").target = self
        file.addItem(withTitle: "打开本地数据文件夹", action: #selector(openDataFolder), keyEquivalent: "").target = self
        file.addItem(withTitle: "打开历史备份", action: #selector(openBackupsFolder), keyEquivalent: "").target = self
        fileItem.submenu = file
        menu.addItem(fileItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }

    private func stopLaunching(message: String) {
        let alert = NSAlert()
        alert.messageText = "想法画布需要重新打开"
        alert.informativeText = message
        alert.addButton(withTitle: "关闭")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

@main @MainActor
struct CanvasEntry {
    static func main() {
        let app = NSApplication.shared
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/想法画布", isDirectory: true)
        let delegate = CanvasApplication(dataRoot: root)
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
