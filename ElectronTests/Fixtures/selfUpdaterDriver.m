// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
// Headless choices for separately compiled, isolated lifecycle fixtures only.
#import "selfUpdaterDriver.h"
#import <AppKit/AppKit.h>
@implementation BaselineFixtureUserDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
    (void)request;
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation { (void)cancellation; fprintf(stderr, "fixture: initiated\n"); }
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    (void)item; (void)state; fprintf(stderr, "fixture: found\n"); reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data { (void)data; }
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error { (void)error; }
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { (void)error; acknowledgement(); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { fprintf(stderr, "fixture: error %s\n", error.description.UTF8String); acknowledgement(); }
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation { (void)cancellation; }
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { (void)length; }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length { (void)length; }
- (void)showDownloadDidStartExtractingUpdate {}
- (void)showExtractionReceivedProgress:(double)progress { (void)progress; }
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply { fprintf(stderr, "fixture: ready\n"); const char *mode = getenv("BASELINE_SELF_UPDATE_FIXTURE_MODE"); reply(mode && strcmp(mode, "cancel-ready") == 0 ? SPUUserUpdateChoiceDismiss : SPUUserUpdateChoiceInstall); }
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
    if (!terminated) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), retry);
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement { (void)relaunched; acknowledgement(); }
- (void)dismissUpdateInstallation {}
- (void)showUpdateInFocus {}
@end

// Click only controls belonging to this fixture's own unmodified Sparkle windows.
// No Accessibility permission or access to another application's UI is needed.
static NSButton *fixtureButton(NSView *view, BOOL install) {
    if ([view isKindOfClass:NSButton.class]) {
        NSButton *button = (NSButton *)view;
        BOOL match = install ? [button.title isEqualToString:@"Install Update"] : [button.accessibilityIdentifier isEqualToString:@"SUStatusCancel"];
        if (match && button.enabled && !button.hidden) return button;
    }
    for (NSView *child in view.subviews) {
        NSButton *button = fixtureButton(child, install);
        if (button) return button;
    }
    return nil;
}
void BaselineFixtureDriveStandardCancellation(void) {
    __block BOOL installedChoice = NO;
    __block NSUInteger attempts = 0;
    [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
        if (++attempts > 100) { [timer invalidate]; return; }
        for (NSWindow *window in NSApp.windows) {
            if (!window.visible) continue;
            NSButton *button = fixtureButton(window.contentView, !installedChoice);
            if (!button) continue;
            fprintf(stderr, "fixture: standard UI %s\n", installedChoice ? "cancel download" : "install choice");
            BOOL cancelling = installedChoice;
            installedChoice = YES;
            [button performClick:nil];
            if (cancelling) [timer invalidate];
            break;
        }
    }];
}
