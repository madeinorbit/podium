// Native WKWebView capture. Compile/run only on the leased Mac runner.
// Session cookie arrives on stdin. Nonpersistent storage prevents disk caches.
import Cocoa
import WebKit

final class Capture: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var timer: Timer?
    var minute = -1
    var busy = false
    let args = CommandLine.arguments
    var root: URL { URL(fileURLWithPath: args[2], isDirectory: true) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let probe = try! String(contentsOfFile: args[3], encoding: .utf8)
        config.userContentController.addUserScript(WKUserScript(source: probe, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 1000), configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled,.closable,.resizable,.miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Podium Memory 5862"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let url = URL(string: args[1])!
        let token = readLine() ?? ""
        guard !token.isEmpty else { NSApp.terminate(nil); return }
        let cookie = HTTPCookie(properties: [.name:"podium_session",.value:token,.domain:url.host!,.path:"/",.secure:url.scheme == "https" ? "TRUE" : "FALSE"])!
        config.websiteDataStore.httpCookieStore.setCookie(cookie) { self.web.load(URLRequest(url: url)) }
        let owned = "{\"pid\":\(ProcessInfo.processInfo.processIdentifier),\"nonpersistent\":true}"
        try! owned.write(to: root.appendingPathComponent("owned-app.json"), atomically: true, encoding: .utf8)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if timer != nil { return }
        timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { _ in
            self.sample()
            self.timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in self.sample() }
        }
    }
    func sample() {
        if busy { return }
        busy = true
        minute += 1
        let script = "JSON.stringify(window.__memoryWK.sample(\(minute)))"
        web.evaluateJavaScript(script) { result, error in
            defer { self.busy = false }
            if let value = result as? String {
                let path = self.root.appendingPathComponent("sample-\(self.minute).json")
                try? value.write(to: path, atomically: true, encoding: .utf8)
                print(value)
                fflush(stdout)
            } else {
                print("{\"event\":\"probe-error\",\"minute\":\(self.minute)}")
                fflush(stdout)
            }
            if self.minute >= Int(self.args[4])! {
                self.timer?.invalidate()
                self.web.stopLoading()
                self.web.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
                    for cookie in cookies { self.web.configuration.websiteDataStore.httpCookieStore.delete(cookie) }
                    self.window.close()
                    NSApp.terminate(nil)
                }
            }
        }
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let capture = Capture()
application.delegate = capture
application.run()
