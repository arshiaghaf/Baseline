// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import AppKit
import Darwin

// A foreign native app keeps the Spaces regression independent of Chromium's
// own full-screen transition on virtual macOS runners.
final class FixtureDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var transitionRequested = false
    private var termination: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGTERM, SIG_IGN)
        termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination?.setEventHandler { NSApp.terminate(nil) }
        termination?.resume()

        let window = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: 800, height: 600),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered, defer: false
        )
        self.window = window
        window.title = "Full-screen fixture"
        window.backgroundColor = .systemBlue
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if NSApp.isActive { enterFullScreen() }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        enterFullScreen()
    }

    private func enterFullScreen() {
        guard let window, !transitionRequested else { return }
        transitionRequested = true
        window.toggleFullScreen(nil)
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        guard let window else { return }
        print(window.windowNumber)
        fflush(stdout)
    }
}

let application = NSApplication.shared
let delegate = FixtureDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
