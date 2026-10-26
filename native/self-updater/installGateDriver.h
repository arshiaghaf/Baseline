// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
#import <Sparkle/Sparkle.h>
// Forward the native UI unchanged while fencing its final install choice.
@interface BaselineInstallGateDriver : NSObject <SPUUserDriver>
- (instancetype)initWithDriver:(id<SPUUserDriver>)driver request:(void (^)(void))request;
- (BOOL)allowInstallation;
- (void)cancelInstallation;
@end
