# macOS permissions

Baseline does not require a blanket privacy grant before checking updates.
It reads app metadata in accessible application folders and queries public update
sources. Additional scan folders can need access to the selected location.

## When an update needs approval

- **App Management** allows software to modify or remove other apps. macOS can
  require this when an update tool changes a protected app bundle. Follow the
  macOS notification, or open **System Settings > Privacy & Security > App
  Management**, and review the app identified by macOS. If the notification names
  Baseline, enable Baseline there, then retry the action.
- **Administrator authorization** is separate. Some Homebrew packages and App
  Store update tools need an administrator password for installation or removal.
  Baseline's Homebrew password helper displays an app-provided masked dialog for
  sudo; it is not the macOS system authorization sheet.
- **App Store sign-in** is an account requirement, separate from both permissions
  above. If an optional `mas` update cannot complete, Baseline opens its external
  update route. You can disable **Use mas for App Store updates** to use App Store
  links instead.

A floating guide appears once on first use at the bottom centre of the active display, without changing the dashboard
or opening Settings automatically. Reopen it from **General > Update Tools > Open
guided setup**. Its **Open Settings** button requests the App Management pane using
a best-effort macOS deep link. If a different page opens, use the manual path above.
Move the floating guide by its header if it covers Settings. Its app card is a
drag source when available; it does not point at a detected system control.
The guide follows Baseline’s light/dark appearance and opens Settings only from
its explicit button.

Enable Baseline's existing switch first. If it is absent and the pane accepts
app drops, drag the app icon into its list; otherwise use the + button, if
available, to select the app. Adding an app is not proof that access is enabled.
Use Settings’ app picker as a keyboard alternative. Dragging uses the verified currently running packaged app bundle, including a
separately named preview. The entire app card is the drag source. Its image is derived from the running
app’s shipped icon, with a Retina representation for the native drag. Development
builds retain manual guidance. Do not assume granting a preview verifies access for another installed copy;
retry the intended copy. Keep a regular installation
in Applications so its path remains stable. The guide requests no Accessibility
or Screen Recording access and does not inspect Settings controls.

Baseline cannot read an App Management grant status. Opening System Settings
does not grant permission. A command's permission error can also mean an
unwritable folder or another restriction; it does not establish a particular
privacy denial. You can continue checking other apps without granting access.

Baseline does not ask for Accessibility, Automation, or Full Disk Access for
ordinary update checks. Sparkle appcasts supply update information; Baseline
opens the publisher page or installed app rather than installing those updates
itself. The publisher's updater handles its own authorization.

Local profile statistics use a Baseline-owned Keychain secret. Keychain access
is separate from privacy grants. First-launch Gatekeeper approval is also
separate; see the [installation instructions](../README.md#first-launch-on-macos-15-and-later).

## Tool compatibility

Baseline uses an optional locally installed `mas`, without pinning its version.
Released mas 4 and current Homebrew mas 7 document administrator authorization
for updates. Baseline's password helper currently covers Homebrew cask commands,
not `mas`; its subprocess has no interactive stdin. An update that needs new
interactive authorization may fail and use the external fallback. App Management
is not a substitute for that authorization. No universal password-free `mas`
update capability is implied by detecting the tool.

## Sources

- [Apple: Privacy & Security settings](https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac)
- [Apple: What's new in privacy, WWDC22](https://developer.apple.com/videos/play/wwdc2022/10096/)
- [Apple DTS: File system permissions, TCC and responsible code](https://developer.apple.com/forums/thread/678819)
- [Electron: systemPreferences APIs](https://www.electronjs.org/docs/latest/api/system-preferences)
- [Homebrew: Cask Cookbook](https://docs.brew.sh/Cask-Cookbook)
- [mas 4 documentation](https://github.com/mas-cli/mas/blob/v4.0.0/README.md)
- [Current mas root-privilege requirements](https://github.com/mas-cli/mas#root-privileges)
