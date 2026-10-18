// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
// Fake sudo endpoint: answer bytes are checked natively and never returned to Node.
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  const char *scenario = getenv("HOMEBREW_BASELINE_FIXTURE_CASE");
  if (!strcmp(scenario, "delivery-error")) return 0;
  const char *expected = !strcmp(scenario, "empty") ? "\n" :
    (!strcmp(scenario, "cancel") || !strcmp(scenario, "error") || !strcmp(scenario, "peer-loss") ||
     !strcmp(scenario, "admission-peer-loss")) ?
    "" : "fixture-native-answer\n";
  size_t at = 0, count = strlen(expected);
  char buffer[64];
  ssize_t n;
  while ((n = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) {
    if (at + (size_t)n > count || memcmp(expected + at, buffer, (size_t)n)) return 71;
    at += (size_t)n;
  }
  return n < 0 || at != count ? 71 : 0;
}
