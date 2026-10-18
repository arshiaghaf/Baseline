# Operation failure details

A failed update, install, or uninstall remains in the Operation failures section.
Choose **Show details** to inspect the reason and available command output. **Copy**
copies details directly to your clipboard. **Report issue** first shows the exact
text that will prefill the bug report's **Logs or screenshots** field. Check it for
private information, then choose **Open on GitHub** to open the form. You still
review and submit the issue yourself; Cancel sends nothing.

Output is a best-effort redacted tail of the combined command stdout and stderr:
at most 20 lines and 8 KiB. GitHub reports may contain less output to keep the
complete encoded issue URL within 6 KiB. Long or uncertain output fragments can be
omitted. Known token patterns, token assignments, authorization headers,
credential-bearing URLs and `/Users/<name>` prefixes are redacted. Other private
information can remain, including path suffixes, so always check before sharing.

The tail stays in memory, survives inventory reconciliation, and clears on the
next user package mutation attempt or when Baseline quits. Failure reason/status
records can remain after relaunch, but output is never added to saved failure
records, ordinary diagnostics or diagnostics export. Uninstall failure notices use
the same redacted tail and show a generic message when no safe tail is available.
Raw command output stays in the main process for progress parsing; it is not
broadcast to renderer windows.
