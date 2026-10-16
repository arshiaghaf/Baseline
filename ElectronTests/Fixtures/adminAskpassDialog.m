// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
// Linked instead of the production dialog. This fixture never initializes AppKit.
#import "../../native/admin-askpass/dialog.h"
#include <unistd.h>

NSString *APRequestAnswer(BOOL *cancelled) {
  const char *scenario = getenv("HOMEBREW_BASELINE_FIXTURE_CASE");
  if (!strcmp(scenario, "peer-loss")) for (;;) pause();
  *cancelled = !strcmp(scenario, "cancel");
  if (*cancelled || !strcmp(scenario, "error")) return nil;
  if (!strcmp(scenario, "empty")) return @"";
  if (!strcmp(scenario, "delivery-error"))
    return [@"x" stringByPaddingToLength:1024 * 1024 withString:@"x" startingAtIndex:0];
  return @"fixture-native-answer";
}
void APFocusDialog(void) {}
