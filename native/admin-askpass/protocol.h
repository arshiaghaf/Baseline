// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <stdint.h>

// Exactly 40 bytes, no string/error/result payload. IDs are opaque bytes.
enum {
  APHello = 1, APBegin = 2, APAnswered = 3, APCancelled = 4,
  APDialogError = 5, APComplete = 6, APInvocationError = 7,
  APFocus = 64, APDeny = 65, APAck = 128
};
typedef struct {
  uint8_t magic[4], version, type, reserved[2], operation[16], prompt[16];
} APFrame;
_Static_assert(sizeof(APFrame) == 40, "Status frames must not contain padding.");
