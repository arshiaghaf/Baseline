// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#import <Security/Security.h>
#include <stdio.h>
#include <string.h>
#include <libproc.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#import "installGateDriver.h"

#ifndef BASELINE_UPDATE_HOST_IDENTIFIER
#define BASELINE_UPDATE_HOST_IDENTIFIER @"com.arshiaghaf.baseline"
#endif
#ifndef BASELINE_UPDATE_FEED_URL
#define BASELINE_UPDATE_FEED_URL @"https://github.com/arshiaghaf/Baseline/releases/latest/download/appcast.xml"
#endif
#ifdef BASELINE_SELF_UPDATE_FIXTURE
#import "selfUpdaterDriver.h"
#endif

static void emit(NSString *event) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"event": event} options:0 error:NULL];
    NSMutableData *line = [data mutableCopy];
    [line appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    (void)write(STDOUT_FILENO, line.bytes, line.length);
}

static void emitFailure(NSError *error) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"event": @"failed", @"code": @(error.code)} options:0 error:NULL];
    NSMutableData *line = [data mutableCopy];
    [line appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    (void)write(STDOUT_FILENO, line.bytes, line.length);
}

// The host is fixed by the helper's embedded location, never by IPC, argv or a feed.
static NSBundle *hostBundle(void) {
    NSURL *url = NSBundle.mainBundle.bundleURL;
    for (NSUInteger i = 0; i < 3; i++) url = url.URLByDeletingLastPathComponent;
    return [NSBundle bundleWithURL:url.URLByResolvingSymlinksInPath];
}

static BOOL parentIsHost(NSBundle *host) {
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(getppid(), executable, sizeof(executable)) <= 0) return NO;
    NSString *actual = [[NSString stringWithUTF8String:executable] stringByResolvingSymlinksInPath];
    return [actual isEqualToString:host.executableURL.URLByResolvingSymlinksInPath.path];
}

static BOOL configurationIsValid(NSBundle *host) {
    NSDictionary *info = host.infoDictionary;
    NSString *key = info[@"SUPublicEDKey"];
    NSData *decoded = [key isKindOfClass:NSString.class] ? [[NSData alloc] initWithBase64EncodedString:key options:0] : nil;
    return [host.bundleIdentifier isEqualToString:BASELINE_UPDATE_HOST_IDENTIFIER] &&
        [info[@"BaselineSignedUpdatesEnabled"] isEqual:@YES] && decoded.length == 32 &&
        [[decoded base64EncodedStringWithOptions:0] isEqualToString:key] &&
        ![key isEqualToString:@"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="] &&
        [info[@"SUFeedURL"] isEqualToString:BASELINE_UPDATE_FEED_URL] &&
        [info[@"SUVerifyUpdateBeforeExtraction"] isEqual:@YES] &&
        [info[@"SURequireSignedFeed"] isEqual:@YES] &&
        [info[@"SUSignedFeedFailureExpirationInterval"] isEqual:@0] &&
        [info[@"SUEnableAutomaticChecks"] isEqual:@NO] &&
        [info[@"SUAutomaticallyUpdate"] isEqual:@NO] &&
        [info[@"SUAllowsAutomaticUpdates"] isEqual:@NO];
}

@interface UpdaterDelegate : NSObject <NSApplicationDelegate, SPUUpdaterDelegate>
@property(nonatomic, strong) SPUUpdater *updater;
@property(nonatomic, strong) BaselineInstallGateDriver *driver;
@property(nonatomic) BOOL installationAuthorized;
@end

@implementation UpdaterDelegate
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
    (void)updater;
    return hostBundle().infoDictionary[@"SUFeedURL"];
}
- (BOOL)updater:(SPUUpdater *)updater shouldProceedWithUpdate:(SUAppcastItem *)item updateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    (void)updater; (void)check;
    BOOL secureURL = !item.fileURL || [item.fileURL.scheme isEqualToString:@"https"];
#ifdef BASELINE_SELF_UPDATE_FIXTURE
    // Only the separately compiled fixture permits loopback HTTP transport.
    // Archive/feed authentication and bundle signature checks stay mandatory.
    secureURL = secureURL || ([item.fileURL.scheme isEqualToString:@"http"] && [item.fileURL.host isEqualToString:@"127.0.0.1"]);
#endif
    if (![item.installationType isEqualToString:@"application"] ||
        !secureURL) {
        if (error) *error = [NSError errorWithDomain:@"com.arshiaghaf.baseline.updater" code:1 userInfo:@{NSLocalizedDescriptionKey: @"This update format is not supported. Download the release manually."}];
        return NO;
    }
    return YES;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    NSBundle *host = hostBundle();
    id<SPUUserDriver> driver;
#ifdef BASELINE_SELF_UPDATE_FIXTURE
    BOOL standardFixture = [NSProcessInfo.processInfo.environment[@"BASELINE_SELF_UPDATE_FIXTURE_MODE"] isEqualToString:@"standard-cancel"];
    driver = standardFixture ? [[SPUStandardUserDriver alloc] initWithHostBundle:host delegate:nil] : [BaselineFixtureUserDriver new];
#else
    driver = [[SPUStandardUserDriver alloc] initWithHostBundle:host delegate:nil];
#endif
    self.driver = [[BaselineInstallGateDriver alloc] initWithDriver:driver request:^{
        emit(@"restart-request");
        // Saving may legitimately wait for accepted producers. Keep this choice
        // pending until explicit acknowledgement/refusal or parent-pipe EOF.
    }];
    self.updater = [[SPUUpdater alloc] initWithHostBundle:host applicationBundle:host userDriver:self.driver delegate:self];
    NSError *error = nil;
    if (![self.updater startUpdater:&error]) { emitFailure(error); [NSApp terminate:nil]; return; }
    emit(@"checking");
    [self.updater checkForUpdates];
#ifdef BASELINE_SELF_UPDATE_FIXTURE
    if (standardFixture) BaselineFixtureDriveStandardCancellation();
#endif
}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
    (void)updater; (void)check;
    if (error && error.code != SUNoUpdateError) emitFailure(error); else emit(@"finished");
    [NSApp terminate:nil];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        NSBundle *host = hostBundle();
        BOOL valid = host && configurationIsValid(host);
        if (argc == 2 && strcmp(argv[1], "--validate-config") == 0) { emit(valid ? @"configured" : @"disabled"); return valid ? 0 : 2; }
        if (argc != 2 || strcmp(argv[1], "--check") != 0 || !valid || !parentIsHost(host)) { emit(@"disabled"); return 2; }
        SecStaticCodeRef code = NULL;
        if (SecStaticCodeCreateWithPath((__bridge CFURLRef)host.bundleURL, kSecCSDefaultFlags, &code) != errSecSuccess) return 2;
        OSStatus signature = SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode, NULL);
        CFRelease(code);
        if (signature != errSecSuccess) { emit(@"failed"); return 2; }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        UpdaterDelegate *delegate = [UpdaterDelegate new];
        NSApp.delegate = delegate;
        // Parent commands are private pipe data, not paths, URLs, keys or shell text.
        // Do not block on stdio here: Foundation's XPath parser also locks stdin.
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char line[32];
            size_t used = 0;
            for (;;) {
                char byte;
                ssize_t count = read(STDIN_FILENO, &byte, 1);
                if (count < 0 && errno == EINTR) continue;
                if (count <= 0 || used == sizeof(line) - 1) break;
                line[used++] = byte;
                if (byte != '\n') continue;
                line[used] = '\0';
                BOOL allow = strcmp(line, "install\n") == 0;
                used = 0;
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (allow && [delegate.driver allowInstallation]) {
                        delegate.installationAuthorized = YES;
                        emit(@"installing");
                    } else { [delegate.driver cancelInstallation]; }
                });
            }
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!delegate.installationAuthorized) [delegate.driver cancelInstallation];
            });
        });
        [NSApp run];
    }
    return 0;
}
