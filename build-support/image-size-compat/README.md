# DMG image dimensions compatibility

`appdmg` still calls the pre-1.0 `image-size(filename, callback)` API. The
upstream parser is vulnerable to malformed ICNS images through version 2.0.2
([GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)).
Version 2 changed that API, so a version override alone breaks DMG creation.

This private build dependency adapts only the filename/callback call used by
`appdmg` to the patched upstream `imageSizeFromFile` API. It rejects missing or
non-positive dimensions and forwards file/parser errors. It contains no image
parser, installation script, or runtime application dependency.

The root `image-size` dev dependency and `appdmg` override must reference the
same local package so a clean `npm ci` resolves it portably. The parser uses a
registry alias to avoid recursively applying that override to itself. Keep its
registry version and integrity in the lockfile; do not substitute an unpinned
Git dependency or modify installed packages in a postinstall step.

Remove this adapter when the DMG builder supports the patched parser's API.
`ElectronTests/dmgImageSize.test.ts` exercises the builder's actual resolution,
malformed ICNS entries, missing files, and the committed 1×/2× backgrounds.
