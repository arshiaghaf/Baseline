# Application icon

`app-icon.icon` is the editable Icon Composer source. Its Default appearance uses
the dark metal artwork; Dark and Tinted use the silver artwork. Keep the embedded
images, transforms, and appearance overrides together.

Forge compiles this document into `Assets.car` on macOS 26 and later with Xcode 26
or later. `app-icon.icns` supplies the composed Default appearance at standard
16–1024 pixel icon sizes for older systems, and also supplies the disk image icon.
`app-icon-legacy.icns` contains the same fallback for packaging on macOS 15, where
the current Electron packager cannot compile Icon Composer documents. Keep both
fallbacks synchronized when changing the source.

To regenerate the fallback, export the source with Icon Composer's `ictool` using
`--export-image --platform macOS --rendition Default --width 1024 --height 1024
--scale 1 --design-generation 26`. Generate an `.iconset` with `sips` containing
16, 32, 128, 256, and 512 point images at both 1× and 2×, then compile it with
`iconutil -c icns`. Use the composed export, including the background and effects,
rather than either transparent foreground layer. Dark web artwork can be exported
with the same command and `--rendition Dark`.

Package checks verify the fallback reference and, on modern build hosts, the
compiled catalog reference. These checks do not establish native Finder or Dock
appearance; review that separately before shipping artwork changes.
