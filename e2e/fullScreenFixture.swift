// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import AppKit
import CoreGraphics
import Darwin

// A foreign native app keeps the Spaces regression independent of Chromium's
// own full-screen transition on virtual macOS runners.
final class FixtureDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var transitionRequested = false
    private var termination: DispatchSourceSignal?
    private let probeMode = CommandLine.arguments.contains("--probe")
    private var transitionStarted = false
    private var probeReported = false

    private func finishProbe(_ status: String) {
        guard probeMode, !probeReported, let window else { return }
        probeReported = true
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let healthyWindow = NSApp.isActive
            && NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()
            && window.isVisible && window.isKeyWindow && window.isOnActiveSpace
            && window.screen != nil
            && window.collectionBehavior.contains(.fullScreenPrimary)
            && window.styleMask.contains(.resizable)
            && session?["kCGSSessionOnConsoleKey"] as? Bool == true
            && session?["kCGSessionLoginDoneKey"] as? Bool == true
            && CGDisplayIsActive(CGMainDisplayID()) != 0
            && CGDisplayIsAsleep(CGMainDisplayID()) == 0
        let result: [String: Any] = [
            "status": status, "healthyWindow": healthyWindow,
            "transitionStarted": transitionStarted,
            "fullScreen": window.styleMask.contains(.fullScreen)
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: result)
            print(String(decoding: data, as: UTF8.self))
            fflush(stdout)
        } catch {
            fputs("Native full-screen probe could not encode its result.\n", stderr)
            exit(EXIT_FAILURE)
        }
        NSApp.terminate(nil)
    }

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
        if probeMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
                self.finishProbe("stalled")
            }
        }
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

    func windowWillEnterFullScreen(_ notification: Notification) {
        transitionStarted = true
    }

    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        finishProbe("failed")
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        guard let window else { return }
        if probeMode {
            finishProbe("completed")
            return
        }
        print(window.windowNumber)
        fflush(stdout)
    }
}

let application = NSApplication.shared
let delegate = FixtureDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
