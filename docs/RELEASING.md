# Releasing Baseline

Baseline currently supports Electron source builds and unsigned DMG release tooling. Use this process for public unsigned releases.

Unsigned DMGs are not notarized by Apple. macOS Gatekeeper may warn users before opening the app. Do not describe unsigned builds as signed, notarized, or production-grade.

## First Release Checklist

1. Choose a version, for example `0.1.0`.
2. Update `package.json` and `package-lock.json` to the release version, then finalize the matching `CHANGELOG.md` section heading with the release date, for example `## 0.1.0 — 2026-05-31`.
3. Run local validation:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:electron
```

4. Optionally build the unsigned release artifacts locally:

```bash
scripts/prepare-unsigned-release.sh 0.1.0
```

5. Commit the release prep changes.
6. Push `main`.
7. Create and push the release tag:

```bash
git tag v0.1.0
git push baseline v0.1.0
```

8. The GitHub Actions release workflow builds the Electron unsigned DMG with the GitHub run number as the macOS build number, writes `dist/Baseline-0.1.0-unsigned.dmg.sha256`, creates the GitHub Release with notes from the finalized changelog section, and uploads both files.
9. Verify the GitHub Release contains:
   - `Baseline-0.1.0-unsigned.dmg`
   - `Baseline-0.1.0-unsigned.dmg.sha256`
   - release notes that include the finalized changelog section and an unsigned build note.

The release workflow accepts tags like `v0.1.0` and `v0.1.0-beta.1`.

The user-facing app version maps to `CFBundleShortVersionString` and is sourced from `package.json`. Release artifact preparation fails if the requested release version does not match `package.json`, `package-lock.json`, or a finalized `CHANGELOG.md` section heading for that version. The build number in parentheses maps to `CFBundleVersion` and should be a monotonically increasing numeric value supplied by CI through `GITHUB_RUN_NUMBER` or overridden explicitly with `BASELINE_BUILD_NUMBER` for local artifact builds.

## Future Signed Release Path

When an Apple Developer account is available, the release process should move to Developer ID signing, notarization, stapling, and a signed DMG.

Do not reuse the unsigned release wording once signed builds are available. Update the README and this document at that time.
