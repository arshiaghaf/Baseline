#!/usr/bin/env swift
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// Run from the repository root: swift scripts/render-dmg-background.swift
// Native system typography matches the app. Both representations are combined
// into a Retina TIFF by electron-installer-dmg; coordinates are Finder points.
import AppKit

let width = 660
let height = 440
func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> NSColor {
    NSColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
}
for scale in [1, 2] {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width * scale, pixelsHigh: height * scale,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let context = NSGraphicsContext.current!.cgContext
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)
    color(246, 248, 251).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()

    func text(_ value: String, y: CGFloat, size: CGFloat, weight: NSFont.Weight, ink: NSColor) {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: ink, .paragraphStyle: style
        ]
        // NSString draws in an unflipped AppKit coordinate space.
        context.saveGState()
        context.translateBy(x: 0, y: 2 * y + size * 1.4)
        context.scaleBy(x: 1, y: -1)
        (value as NSString).draw(in: NSRect(x: 36, y: y, width: 588, height: size * 1.4), withAttributes: attributes)
        context.restoreGState()
    }
    text("Baseline", y: 55, size: 34, weight: .semibold, ink: color(13, 13, 13))
    text("Drag Baseline to Applications to install.", y: 106, size: 16, weight: .regular, ink: color(76, 87, 104))

    // A restrained directional cue leaves native app/folder icons as the focus.
    color(1, 105, 204).setStroke()
    let arrow = NSBezierPath()
    arrow.lineWidth = 2.5
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: 306, y: 260))
    arrow.line(to: NSPoint(x: 354, y: 260))
    arrow.move(to: NSPoint(x: 344, y: 250))
    arrow.line(to: NSPoint(x: 354, y: 260))
    arrow.line(to: NSPoint(x: 344, y: 270))
    arrow.stroke()
    text("Then open Baseline from Applications.", y: 372, size: 13, weight: .regular, ink: color(91, 102, 118))
    NSGraphicsContext.restoreGraphicsState()
    let suffix = scale == 1 ? "" : "@2x"
    let data = bitmap.representation(using: .png, properties: [:])!
    try data.write(to: URL(fileURLWithPath: "assets/dmg/background\(suffix).png"))
}
