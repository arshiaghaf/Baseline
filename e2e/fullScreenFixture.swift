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
    private let diagnostic = CommandLine.arguments.contains("--diagnose")

    private func report(_ phase: String) {
        guard diagnostic else { return }
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let state: [String: Any] = [
            "phase": phase,
            "active": NSApp.isActive,
            "frontmostPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
            "onConsole": session?["kCGSSessionOnConsoleKey"] as? Bool ?? false,
            "loginDone": session?["kCGSessionLoginDoneKey"] as? Bool ?? false,
            "visible": window?.isVisible ?? false,
            "key": window?.isKeyWindow ?? false,
            "onActiveSpace": window?.isOnActiveSpace ?? false,
            "styleMask": window?.styleMask.rawValue ?? 0,
            "collectionBehavior": window?.collectionBehavior.rawValue ?? 0,
            "fullScreen": window?.styleMask.contains(.fullScreen) ?? false,
            "screenSize": [window?.screen?.frame.width ?? 0, window?.screen?.frame.height ?? 0],
            "displayActive": CGDisplayIsActive(CGMainDisplayID()),
            "displayAsleep": CGDisplayIsAsleep(CGMainDisplayID()),
            "reduceMotion": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        ]
        if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) {
            FileHandle.standardError.write(data + Data("\n".utf8))
        }
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
        report("launched")
        if diagnostic {
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
                self.report("deadline")
                NSApp.terminate(nil)
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        if NSApp.isActive { enterFullScreen() }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        report("became-active")
        enterFullScreen()
    }

    private func enterFullScreen() {
        guard let window, !transitionRequested else { return }
        transitionRequested = true
        report("requested")
        window.toggleFullScreen(nil)
    }

    func windowWillEnterFullScreen(_ notification: Notification) {
        report("will-enter")
    }

    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        report("failed-to-enter")
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        guard let window else { return }
        report("did-enter")
        if diagnostic {
            DispatchQueue.main.async { NSApp.terminate(nil) }
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
