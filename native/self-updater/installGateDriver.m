// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
#import "installGateDriver.h"
@implementation BaselineInstallGateDriver {
    id<SPUUserDriver> _driver;
    void (^_request)(void);
    void (^_reply)(SPUUserUpdateChoice);
    void (^_cancelDownload)(void);
    BOOL _cancelled;
}
- (instancetype)initWithDriver:(id<SPUUserDriver>)driver request:(void (^)(void))request {
    self = [super init];
    if (self) { _driver = driver; _request = [request copy]; }
    return self;
}
- (BOOL)allowInstallation {
    if (_cancelled || !_reply) return NO;
    void (^reply)(SPUUserUpdateChoice) = _reply;
    _reply = nil;
    reply(SPUUserUpdateChoiceInstall);
    return YES;
}
- (void)cancelInstallation {
    _cancelled = YES;
    if (_cancelDownload) {
        void (^cancel)(void) = _cancelDownload;
        _cancelDownload = nil;
        cancel();
    }
    if (_reply) {
        void (^reply)(SPUUserUpdateChoice) = _reply;
        _reply = nil;
        // Skip explicitly cancels a staged installation; Dismiss preserves install-on-quit.
        reply(SPUUserUpdateChoiceSkip);
    }
}
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply { [_driver showUpdatePermissionRequest:request reply:reply]; }
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
    _cancelDownload = [cancellation copy];
    if (_cancelled) { [self cancelInstallation]; return; }
    [_driver showUserInitiatedUpdateCheckWithCancellation:cancellation];
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    _cancelDownload = nil;
    if (_cancelled || state.stage == SPUUserUpdateStageInstalling) { reply(SPUUserUpdateChoiceSkip); return; }
    _reply = [reply copy];
    [_driver showUpdateFoundWithAppcastItem:item state:state reply:^(SPUUserUpdateChoice choice) {
        if (!self->_reply) return;
        void (^respond)(SPUUserUpdateChoice) = self->_reply;
        self->_reply = nil;
        respond(self->_cancelled ? SPUUserUpdateChoiceSkip : choice);
    }];
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data { [_driver showUpdateReleaseNotesWithDownloadData:data]; }
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error { [_driver showUpdateReleaseNotesFailedToDownloadWithError:error]; }
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { [_driver showUpdateNotFoundWithError:error acknowledgement:acknowledgement]; }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { [_driver showUpdaterError:error acknowledgement:acknowledgement]; }
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
    _cancelDownload = [cancellation copy];
    if (_cancelled) { [self cancelInstallation]; return; }
    [_driver showDownloadInitiatedWithCancellation:cancellation];
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { [_driver showDownloadDidReceiveExpectedContentLength:length]; }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length { [_driver showDownloadDidReceiveDataOfLength:length]; }
- (void)showDownloadDidStartExtractingUpdate { _cancelDownload = nil; [_driver showDownloadDidStartExtractingUpdate]; }
- (void)showExtractionReceivedProgress:(double)progress { [_driver showExtractionReceivedProgress:progress]; }
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
    _reply = [reply copy];
    if (_cancelled) { [self cancelInstallation]; return; }
    [_driver showReadyToInstallAndRelaunch:^(SPUUserUpdateChoice choice) {
        if (!self->_reply) return;
        if (choice == SPUUserUpdateChoiceInstall) self->_request();
        else [self cancelInstallation];
    }];
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry { [_driver showInstallingUpdateWithApplicationTerminated:terminated retryTerminatingApplication:retry]; }
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement { [_driver showUpdateInstalledAndRelaunched:relaunched acknowledgement:acknowledgement]; }
- (void)dismissUpdateInstallation { _cancelDownload = nil; _reply = nil; [_driver dismissUpdateInstallation]; }
- (void)showUpdateInFocus { if ([_driver respondsToSelector:@selector(showUpdateInFocus)]) [_driver showUpdateInFocus]; }
@end
