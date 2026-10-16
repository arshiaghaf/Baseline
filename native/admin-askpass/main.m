// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
#import "dialog.h"
#include "protocol.h"
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <time.h>

static int channel = -1;
static APFrame identity;
static pthread_mutex_t stateLock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t acknowledgement = PTHREAD_COND_INITIALIZER;
static uint8_t expectedAck;
static BOOL ackReceived;
static _Atomic bool dialogOpen;

static BOOL transfer(int fd, void *buffer, size_t count, BOOL writing) {
  uint8_t *cursor = buffer;
  while (count) {
    ssize_t n = writing ? write(fd, cursor, count) : read(fd, cursor, count);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return NO;
    count -= (size_t)n;
    cursor += n;
  }
  return YES;
}

static BOOL sameIdentity(APFrame frame) {
  return !memcmp(frame.magic, "BAP1", 4) && frame.version == 1 &&
    !frame.reserved[0] && !frame.reserved[1] &&
    !memcmp(frame.operation, identity.operation, 16) &&
    !memcmp(frame.prompt, identity.prompt, 16);
}

static void *monitor(void *unused) {
  (void)unused;
  for (;;) {
    APFrame frame;
    // EOF must be observed even while NSAppleScript blocks the UI thread.
    // Exit the owning helper, never target another process or log a result.
    if (!transfer(channel, &frame, sizeof(frame), NO) || !sameIdentity(frame)) _exit(70);
    pthread_mutex_lock(&stateLock);
    if (frame.type == APFocus && atomic_load(&dialogOpen)) {
      APFocusDialog();
    } else if (frame.type == expectedAck && !ackReceived) {
      ackReceived = YES;
      pthread_cond_signal(&acknowledgement);
      if (frame.type == (APComplete | APAck) || frame.type == (APInvocationError | APAck)) {
        pthread_mutex_unlock(&stateLock);
        return NULL;
      }
    } else if (frame.type != APFocus) {
      _exit(70);
    }
    pthread_mutex_unlock(&stateLock);
  }
}

static BOOL phase(uint8_t type) {
  pthread_mutex_lock(&stateLock);
  APFrame frame = identity;
  frame.type = type;
  expectedAck = type | APAck;
  ackReceived = NO;
  if (!transfer(channel, &frame, sizeof(frame), YES)) _exit(70);
  // Protocol acknowledgment only; never a deadline on the password dialog.
  struct timespec deadline;
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += 3;
  while (!ackReceived) {
    if (pthread_cond_timedwait(&acknowledgement, &stateLock, &deadline)) _exit(70);
  }
  pthread_mutex_unlock(&stateLock);
  return YES;
}

static BOOL decodeID(const char *text, uint8_t *out) {
  if (!text || strlen(text) != 32) return NO;
  uint8_t any = 0;
  for (size_t i = 0; i < 16; ++i) {
    unsigned value = 0;
    for (size_t j = 0; j < 2; ++j) {
      char c = text[i * 2 + j];
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return NO;
      value = value * 16 + (c <= '9' ? c - '0' : c - 'a' + 10);
    }
    out[i] = (uint8_t)value;
    any |= out[i];
  }
  return any != 0;
}

int main(void) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    // Do not produce core files containing the dialog result.
    struct rlimit limit = {0, 0};
    if (setrlimit(RLIMIT_CORE, &limit)) return 70;
    struct stat output;
    if (fstat(STDOUT_FILENO, &output) || !S_ISFIFO(output.st_mode)) return 70;
    const char *endpoint = getenv("HOMEBREW_BASELINE_ASKPASS_SOCKET");
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    if (!endpoint || endpoint[0] != '/' || strlen(endpoint) >= sizeof(address.sun_path) ||
        !decodeID(getenv("HOMEBREW_BASELINE_ASKPASS_OPERATION"), identity.operation)) return 70;
    memcpy(identity.magic, "BAP1", 4);
    identity.version = 1;
    arc4random_buf(identity.prompt, sizeof(identity.prompt));
    strlcpy(address.sun_path, endpoint, sizeof(address.sun_path));
    channel = socket(AF_UNIX, SOCK_STREAM, 0);
    if (channel < 0 || connect(channel, (struct sockaddr *)&address, sizeof(address))) return 70;
    // Refuse a different-user status peer; same-user replacement is outside the
    // ordinary stable-user-configuration trust boundary.
    uid_t uid;
    gid_t gid;
    if (getpeereid(channel, &uid, &gid) || uid != getuid()) return 70;
    pthread_t watcher;
    if (pthread_create(&watcher, NULL, monitor, NULL)) return 70;
    phase(APHello);
    phase(APBegin);
    atomic_store(&dialogOpen, true);
    BOOL cancelled = NO;
    NSString *answer = APRequestAnswer(&cancelled);
    pthread_mutex_lock(&stateLock);
    atomic_store(&dialogOpen, false);
    pthread_mutex_unlock(&stateLock);
    if (cancelled || !answer) {
      phase(cancelled ? APCancelled : APDialogError);
      if (close(STDOUT_FILENO)) { phase(APInvocationError); return 70; }
      phase(APComplete);
      _exit(cancelled ? 1 : 70);
    }
    phase(APAnswered); // Nonterminal: no assertion of delivery or authentication.
    NSData *bytes = [answer dataUsingEncoding:NSUTF8StringEncoding];
    // Askpass is line oriented. Refuse unsupported embedded line terminators or
    // NUL rather than silently submitting a different answer.
    if (!bytes || memchr(bytes.bytes, '\n', bytes.length) ||
        memchr(bytes.bytes, '\r', bytes.length) || memchr(bytes.bytes, 0, bytes.length) ||
        !transfer(STDOUT_FILENO, (void *)bytes.bytes, bytes.length, YES) ||
        !transfer(STDOUT_FILENO, "\n", 1, YES) || close(STDOUT_FILENO)) {
      phase(APInvocationError);
      _exit(70);
    }
    phase(APComplete);
    _exit(0);
  }
}
