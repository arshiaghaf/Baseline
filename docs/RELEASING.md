# Releasing Baseline

Baseline currently supports Electron source builds and optional unsigned preview DMGs.

Unsigned DMGs are not notarized by Apple. macOS Gatekeeper may warn users before opening the app. Do not describe unsigned builds as signed, notarized, or production-grade.

## Release Checklist

1. Choose a version, for example `0.1.0`.
2. Update `CHANGELOG.md`.
3. Run local validation:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:electron
```

4. Optionally preview the unsigned release artifacts locally:

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

8. The GitHub Actions release workflow builds the Electron unsigned DMG, writes `dist/Baseline-0.1.0-unsigned.dmg.sha256`, creates the GitHub Release, and uploads both files.
9. Verify the GitHub Release contains:
   - `Baseline-0.1.0-unsigned.dmg`
   - `Baseline-0.1.0-unsigned.dmg.sha256`
   - release notes that clearly label the artifact as unsigned.

The release workflow accepts tags like `v0.1.0` and `v0.1.0-beta.1`.

## Future Signed Release Path

When an Apple Developer account is available, the release process should move to Developer ID signing, notarization, stapling, and a signed DMG.

Do not reuse the unsigned release wording once signed builds are available. Update the README and this document at that time.
