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
    private var syncActivity: NSObjectProtocol?
    private var syncReady = false
    private let syncPort: UInt16 = 47471
    private var window: NSWindow?
    private var webView: WKWebView?
    private var layoutURL: URL?
    private var terminationPending = false
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
            let initialBackground = NSColor(srgbRed: 0.961, green: 0.965, blue: 0.973, alpha: 1.0)
            webView.underPageBackgroundColor = initialBackground
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1270, height: 810),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered, defer: false
            )
            window.title = "想法画布"
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = false
            window.backgroundColor = initialBackground
            window.minSize = NSSize(width: 510, height: 395)
            window.delegate = self
            window.contentView = webView
            if !window.setFrameUsingName(Self.windowFrameName) { window.center() }
            window.setFrameAutosaveName(Self.windowFrameName)
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

    func windowDidEnterFullScreen(_ notification: Notification) {
        webView?.evaluateJavaScript(
            "document.documentElement.dataset.fullscreen = 'true'; window.dispatchEvent(new Event('resize'));",
            completionHandler: nil
        )
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        webView?.evaluateJavaScript(
            "delete document.documentElement.dataset.fullscreen; window.dispatchEvent(new Event('resize'));",
            completionHandler: nil
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        syncServer?.stop()
        if let activity = syncActivity {
            ProcessInfo.processInfo.endActivity(activity)
            syncActivity = nil
        }
    }

    private func beginBrowserSync(layoutURL: URL, store: DiskWorkspace) {
        do {
            let html = try String(contentsOf: layoutURL, encoding: .utf8)
            var page = html
            if let range = page.range(of: "<!-- LOCAL_CANVAS_SYNC -->") {
                page.replaceSubrange(range, with: #"<meta id="canvas-browser-sync">"#)
            }
            let server = try CanvasLoopback(
                port: syncPort, page: Data(page.utf8), root: dataRoot,
                read: { try store.snapshot(since: $0) },
                write: { [weak self] expected, json in
                    let snapshot = try store.saveSynced(json, expectedRevision: expected)
                    Task { @MainActor [weak self] in
                        _ = try? await self?.webView?.callAsyncJavaScript(
                            "window.dispatchEvent(new Event('focus'));",
                            arguments: [:], in: nil, contentWorld: .page
                        )
                    }
                    return snapshot
                }
            )
            syncServer = server
            server.start { [weak self] ready in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.syncReady = ready
                    if ready {
                        if self.syncActivity == nil {
                            self.syncActivity = ProcessInfo.processInfo.beginActivity(
                                options: [.userInitiatedAllowingIdleSystemSleep],
                                reason: "Serving local canvas sync and agent API on loopback"
                            )
                        }
                    } else if let activity = self.syncActivity {
                        ProcessInfo.processInfo.endActivity(activity)
                        self.syncActivity = nil
                    }
                }
            }
        } catch {
            syncReady = false
        }
    }

    @objc private func copySyncLink() {
        guard let window, window.attachedSheet == nil else { return }
        let alert = NSAlert()
        do {
            guard syncReady, let server = syncServer else {
                alert.messageText = "暂时无法连接浏览器"
                alert.informativeText = "请检查本机画布能正常保存，再退出并重新打开桌面版。"
                alert.addButton(withTitle: "确定")
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                alert.beginSheetModal(for: window, completionHandler: nil)
                return
            }
            let link = try server.makePairingLink()
            let clipboard = NSPasteboard.general
            clipboard.clearContents()
            clipboard.setString(link.absoluteString, forType: .string)
            alert.messageText = "已复制浏览器同步链接"
            alert.informativeText = "把链接粘贴到 GPT 内嵌浏览器的地址栏。首次连接后，这台 Mac 上的两个入口会读写同一份画布。链接仅可使用一次。"
            alert.addButton(withTitle: "确定")
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            alert.beginSheetModal(for: window, completionHandler: nil)
        } catch {
            alert.messageText = "暂时无法复制同步链接"
            alert.informativeText = error.localizedDescription
            alert.addButton(withTitle: "确定")
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            alert.beginSheetModal(for: window, completionHandler: nil)
        }
    }

    private static func snapshotObject(_ snapshot: CanvasSyncSnapshot) -> [String: Any] {
        ["revision": snapshot.revision, "json": snapshot.json as Any? ?? NSNull()]
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let webView, let window else { return .terminateNow }
        guard !terminationPending else { return .terminateLater }
        terminationPending = true
        Task { [weak self] in
            guard let self else {
                sender.reply(toApplicationShouldTerminate: true)
                return
            }
            let saved = try? await webView.callAsyncJavaScript(
                "return window.ideaCanvasBeforeQuit ? await window.ideaCanvasBeforeQuit() : true;",
                arguments: [:], in: nil, contentWorld: .page
            )
            if saved as? Bool == true {
                self.terminationPending = false
                sender.reply(toApplicationShouldTerminate: true)
                return
            }
            let alert = NSAlert()
            alert.messageText = "还有内容未写入本机"
            alert.informativeText = "返回画布可导出可编辑 HTML。"
            alert.addButton(withTitle: "返回画布")
            alert.addButton(withTitle: "退出")
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            alert.beginSheetModal(for: window) { response in
                self.terminationPending = false
                sender.reply(toApplicationShouldTerminate: response == .alertSecondButtonReturn)
            }
        }
        return .terminateLater
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
        case "window-chrome":
            let dark = (body["dark"] as? Bool) ?? false
            window?.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            if let hex = body["background"] as? String, let bgColor = Self.color(fromHex: hex) {
                window?.backgroundColor = bgColor
                webView?.underPageBackgroundColor = bgColor
            }
            replyHandler(true, nil)
        case "clipboard-write":
            guard let text = body["text"] as? String else {
                replyHandler(nil, "剪贴板数据无法读取。")
                return
            }
            let clipboard = NSPasteboard.general
            clipboard.clearContents()
            let ok = clipboard.setString(text, forType: .string)
            replyHandler(ok, ok ? nil : "无法写入系统剪贴板。")
        default:
            replyHandler(nil, "无法识别此操作。")
        }
    }

    private static func color(fromHex hex: String) -> NSColor? {
        let trimmed = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("#"), trimmed.count == 7,
              let value = UInt32(trimmed.dropFirst(), radix: 16) else { return nil }
        let r = CGFloat((value >> 16) & 0xff) / 255.0
        let g = CGFloat((value >> 8) & 0xff) / 255.0
        let b = CGFloat(value & 0xff) / 255.0
        return NSColor(srgbRed: r, green: g, blue: b, alpha: 1.0)
    }

    private static let windowFrameName = "IdeaCanvasMainWindow"
    private static let exportFormats: [String: (title: String, type: UTType)] = [
        "html": ("导出可编辑 HTML", .html),
        "json": ("导出 JSON", .json),
        "md": ("导出 Markdown", UTType(filenameExtension: "md") ?? .plainText),
        "svg": ("导出 SVG 矢量图", .svg),
        "png": ("导出 PNG 图片", .png),
    ]

    private func export(_ body: [String: Any], replyHandler: @escaping (Any?, String?) -> Void) {
        guard let window, let kind = body["kind"] as? String, let format = Self.exportFormats[kind],
            let filename = body["filename"] as? String, let contents = body["contents"] as? String else {
            replyHandler(nil, "导出数据无法读取。")
            return
        }
        let payload = kind == "png" ? Data(base64Encoded: contents) : Data(contents.utf8)
        guard let payload else {
            replyHandler(nil, "导出数据无法读取。")
            return
        }
        let panel = NSSavePanel()
        panel.title = format.title
        panel.allowedContentTypes = [format.type]
        panel.nameFieldStringValue = URL(fileURLWithPath: filename).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [fileQueue, store] response in
            guard response == .OK, let destination = panel.url else {
                replyHandler(false, nil)
                return
            }
            let outputPath = destination.resolvingSymlinksInPath().path.lowercased()
            if let store {
                let rootPath = store.root.resolvingSymlinksInPath().path.lowercased()
                if outputPath == rootPath || outputPath.hasPrefix(rootPath + "/") {
                    replyHandler(nil, "请选择画布数据文件夹之外的位置。")
                    return
                }
            }
            fileQueue.async {
                do {
                    try payload.write(to: destination, options: .atomic)
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
        if !openedLayout, requested == layoutURL?.resolvingSymlinksInPath().standardizedFileURL {
            openedLayout = true
            decisionHandler(.allow)
            return
        }
        if openedLayout,
           navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           ["http", "https"].contains(scheme) {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           ["http", "https"].contains(scheme) {
            NSWorkspace.shared.open(url)
        }
        return nil
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

    @objc private func toggleLocalAPI(_ sender: NSMenuItem) {
        let marker = dataRoot.appendingPathComponent("local-api.disabled")
        let manager = FileManager.default
        do {
            if manager.fileExists(atPath: marker.path) {
                try manager.removeItem(at: marker)
                sender.state = .on
            } else {
                try Data("disabled\n".utf8).write(to: marker, options: .atomic)
                try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
                sender.state = .off
            }
        } catch {
            if let window, window.attachedSheet == nil {
                let alert = NSAlert()
                alert.messageText = "无法切换本机 AI / MCP 接入状态"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "确定")
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                alert.beginSheetModal(for: window, completionHandler: nil)
            }
        }
    }

    private func runCanvasCommand(_ name: String, nativeFallback: Selector? = nil) {
        if let window, window.attachedSheet != nil {
            if let nativeFallback { NSApp.sendAction(nativeFallback, to: nil, from: nil) }
            return
        }
        if let nativeFallback, let window, NSApp.keyWindow !== window {
            NSApp.sendAction(nativeFallback, to: nil, from: nil)
            return
        }
        window?.makeKeyAndOrderFront(nil)
        webView?.evaluateJavaScript("window.ideaCanvasCommand ? window.ideaCanvasCommand('\(name)') : 'ignored'") { result, _ in
            // Text fields keep their own undo/clipboard history inside WebKit; page script cannot trigger it.
            if let nativeFallback, result as? String == "native" {
                NSApp.sendAction(nativeFallback, to: nil, from: nil)
            }
        }
    }

    @objc private func canvasUndo() { runCanvasCommand("undo", nativeFallback: Selector(("undo:"))) }
    @objc private func canvasRedo() { runCanvasCommand("redo", nativeFallback: Selector(("redo:"))) }
    @objc private func canvasCut() { runCanvasCommand("cut", nativeFallback: #selector(NSText.cut(_:))) }
    @objc private func canvasCopy() { runCanvasCommand("copy", nativeFallback: #selector(NSText.copy(_:))) }
    @objc private func canvasSelectAll() { runCanvasCommand("select-all", nativeFallback: #selector(NSText.selectAll(_:))) }
    @objc private func canvasExportPNG() { runCanvasCommand("export-png") }
    @objc private func canvasExportSVG() { runCanvasCommand("export-svg") }
    @objc private func canvasExportMarkdown() { runCanvasCommand("export-markdown") }
    @objc private func canvasExportHTML() { runCanvasCommand("export-html") }
    @objc private func canvasFit() { runCanvasCommand("fit") }
    @objc private func canvasPalette() { runCanvasCommand("search") }

    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "想法画布")
        appMenu.addItem(withTitle: "关于想法画布", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏想法画布", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出想法画布", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let fileItem = NSMenuItem()
        let file = NSMenu(title: "文件")
        file.addItem(withTitle: "导出 PNG 图片…", action: #selector(canvasExportPNG), keyEquivalent: "").target = self
        file.addItem(withTitle: "导出 SVG 矢量图…", action: #selector(canvasExportSVG), keyEquivalent: "").target = self
        file.addItem(withTitle: "导出 Markdown…", action: #selector(canvasExportMarkdown), keyEquivalent: "").target = self
        file.addItem(withTitle: "导出可编辑 HTML…", action: #selector(canvasExportHTML), keyEquivalent: "").target = self
        file.addItem(.separator())
        file.addItem(withTitle: "复制浏览器同步链接", action: #selector(copySyncLink), keyEquivalent: "").target = self
        let localAPIItem = NSMenuItem(title: "允许本机 AI / MCP 接入", action: #selector(toggleLocalAPI(_:)), keyEquivalent: "")
        localAPIItem.target = self
        localAPIItem.state = CanvasLoopback.isLocalAPIEnabled(in: dataRoot) ? .on : .off
        file.addItem(localAPIItem)
        file.addItem(withTitle: "打开本地数据文件夹", action: #selector(openDataFolder), keyEquivalent: "").target = self
        file.addItem(withTitle: "打开历史备份", action: #selector(openBackupsFolder), keyEquivalent: "").target = self
        file.addItem(.separator())
        file.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file
        menu.addItem(fileItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: #selector(canvasUndo), keyEquivalent: "z").target = self
        let redo = NSMenuItem(title: "重做", action: #selector(canvasRedo), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        redo.target = self
        edit.addItem(redo)
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(canvasCut), keyEquivalent: "x").target = self
        edit.addItem(withTitle: "复制", action: #selector(canvasCopy), keyEquivalent: "c").target = self
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(canvasSelectAll), keyEquivalent: "a").target = self
        editItem.submenu = edit
        menu.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "显示")
        view.addItem(withTitle: "搜索或执行命令", action: #selector(canvasPalette), keyEquivalent: "").target = self
        view.addItem(withTitle: "查看全图", action: #selector(canvasFit), keyEquivalent: "").target = self
        view.addItem(.separator())
        let fullScreen = NSMenuItem(title: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fullScreen)
        viewItem.submenu = view
        menu.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "前置全部窗口", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
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
