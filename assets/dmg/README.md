# Installer artwork

The original background uses Baseline's system typography, neutral surfaces and
blue update accent (`#0169cc`). The app icon and Applications folder are real
Finder items, not painted drag targets. No third-party artwork is used.

`layout.json` shares the 660 × 440-point canvas, 112-point icons and icon centers
between Forge and the unsigned release helper. Keep the arrow and text clear of
the native icon labels. Finder adds its own title bar outside this canvas.

To regenerate both PNG representations on macOS, run from the repository root:

```sh
swift scripts/render-dmg-background.swift
```

The committed 1× and 2× PNGs avoid a Swift/Xcode requirement when making a DMG.
The DMG builder combines them into a multi-resolution TIFF for Retina Finder.
The fixed light canvas keeps artwork legible in both macOS appearances; Finder
controls the native filename labels. Native Finder appearance review is optional
and does not block releases. User settings that show hidden files can expose DMG
metadata.

Keep the automated release checks: app build, `hdiutil` integrity verification and
read-only mount, the `/Applications` symlink target, `.DS_Store` and background
existence, and `codesign` verification of the mounted app. CI runs these structural
and integrity checks without requiring native Finder appearance inspection.

To package an already built app without launching or installing it:

```sh
node scripts/package-dmg.mjs out/Baseline-darwin-arm64/Baseline.app dist/Baseline-review.dmg "Baseline Review"
```

The release helper retains its `Baseline-<version>-unsigned.dmg` filename, volume
title and UDZO compression. Forge retains its ULFO format. Neither path changes
app signing or adds notarization.
