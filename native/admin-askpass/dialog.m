// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
#import <AppKit/AppKit.h>
#import "dialog.h"

NSString *APRequestAnswer(BOOL *cancelled) {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [NSApp activateIgnoringOtherApps:YES];
  // Never interpolate sudo argv, labels, or metadata into this static script.
  NSAppleScript *script = [[NSAppleScript alloc] initWithSource:
    @"text returned of (display dialog \"Homebrew needs administrator permission to continue this operation.\\n\\n"
     "This password dialog is provided by Baseline.\" "
     "with title \"Baseline\" default answer \"\" with hidden answer "
     "buttons {\"Cancel\", \"Continue\"} default button \"Continue\" cancel button \"Cancel\")"];
  NSDictionary *error = nil;
  NSAppleEventDescriptor *result = [script executeAndReturnError:&error];
  *cancelled = [error[NSAppleScriptErrorNumber] intValue] == -128;
  // In particular, never call description on result or error.
  return error ? nil : result.stringValue;
}

void APFocusDialog(void) {
  // Called by the socket monitor while the script waits synchronously. Native
  // foreground/teardown behavior still requires the explicit GUI handoff.
  [NSRunningApplication.currentApplication activateWithOptions:NSApplicationActivateAllWindows];
}
