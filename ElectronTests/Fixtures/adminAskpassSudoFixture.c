// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
// Safe sudo-policy stand-in. Answers remain in native pipes/memory and never
// reach Node, output, argv, environment, or files. This is not credential proof.
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;

static int invoke(char *helper, const char *scenario, const char *expected, int expectedStatus) {
  int channel[2];
  if (pipe(channel) || setenv("HOMEBREW_BASELINE_FIXTURE_CASE", scenario, 1)) return 71;
  posix_spawn_file_actions_t actions;
  if (posix_spawn_file_actions_init(&actions)) return 71;
  if (posix_spawn_file_actions_adddup2(&actions, channel[1], STDOUT_FILENO) ||
      posix_spawn_file_actions_addclose(&actions, channel[0]) ||
      posix_spawn_file_actions_addclose(&actions, channel[1]) ||
      posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0)) {
    posix_spawn_file_actions_destroy(&actions);
    close(channel[0]); close(channel[1]); return 71;
  }
  pid_t pid;
  char *arguments[] = {helper, NULL};
  int launched = posix_spawn(&pid, helper, &actions, NULL, arguments, environ);
  posix_spawn_file_actions_destroy(&actions);
  close(channel[1]);
  if (launched) { close(channel[0]); return 70; }
  size_t at = 0, count = strlen(expected);
  char buffer[128];
  int valid = 1;
  ssize_t length;
  for (;;) {
    length = read(channel[0], buffer, sizeof(buffer));
    if (length < 0 && errno == EINTR) continue;
    if (length <= 0) break;
    if (at + (size_t)length > count || memcmp(buffer, expected + at, (size_t)length)) valid = 0;
    at += (size_t)length;
  }
  close(channel[0]);
  int status;
  while (waitpid(pid, &status, 0) < 0) { if (errno != EINTR) return 71; }
  return !valid || length < 0 || at != count || !WIFEXITED(status) ||
    WEXITSTATUS(status) != expectedStatus ? 71 : 0;
}

int main(int argc, char **argv) {
  if (argc != 3) return 71;
  const char *mode = argv[2];
  if (!strcmp(mode, "cached") || !strcmp(mode, "no-sudo")) return 0;
  if (!strcmp(mode, "crash")) return invoke(argv[1], "crash", "", 70) ? 71 : 70;
  if (!strcmp(mode, "missing-completion")) return invoke(argv[1], "missing-completion", "", 0) ? 71 : 0;
  if (!strcmp(mode, "hold")) return invoke(argv[1], "peer-loss", "", 70) ? 71 : 70;
  if (!strcmp(mode, "empty")) return invoke(argv[1], "empty", "\n", 0) ? 71 : 1;
  int rounds = !strcmp(mode, "exhaustion") ? 5 : !strcmp(mode, "wrong-then-correct") ? 2 : 1;
  if (!strcmp(mode, "cancel-after-rejection")) rounds = 2;
  for (int attempt = 0; attempt < rounds; ++attempt) {
    int cancelled = !strcmp(mode, "cancel") ||
      (!strcmp(mode, "cancel-after-rejection") && attempt == 1);
    if (invoke(argv[1], cancelled ? "cancel" : "answer", cancelled ? "" : "fixture-native-answer\n", cancelled ? 1 : 0)) return 71;
    if (cancelled) {
      // Model a sudo policy that asks again after cancellation: the coordinator
      // must refuse admission, regardless of this stand-in's retry attempt.
      return invoke(argv[1], "answer", "", 70) ? 71 : 1;
    }
  }
  return !strcmp(mode, "exhaustion") ? 1 : 0;
}
