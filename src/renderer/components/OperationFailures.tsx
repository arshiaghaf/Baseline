// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BaselineSnapshot } from "../../shared/domain";
import { operationFailureDescription, type OperationFailure } from "../../shared/operationFailures";
import { operationIssueReport } from "../../shared/operationReport";
import { trapFocusWithin } from "../helpers/focus";

export function OperationFailures({ snapshot }: { snapshot: BaselineSnapshot }) {
  if (!snapshot.operationFailures?.length) return null;
  return (
    <section className="operation-failures" aria-label="Operation failures">
      {snapshot.operationFailures.map((failure) => {
        const name =
          snapshot.apps.find((app) => app.id === failure.entityID)?.displayName ??
          snapshot.homebrewItems.find((item) => item.id === failure.entityID)?.name ??
          snapshot.homebrewDiscoverItems.find((item) => item.id === failure.entityID)
            ?.displayName ??
          (failure.entityID === "homebrew:maintenance" ? "Homebrew maintenance" : "This item");
        const details = snapshot.operationFailureDetails?.[failure.id];
        return (
          <OperationFailureRow
            key={`${failure.id}:${details?.attemptID ?? failure.occurredAt}`}
            failure={failure}
            name={name}
            attemptID={details?.attemptID ?? failure.occurredAt}
            outputTail={details?.outputTail}
          />
        );
      })}
    </section>
  );
}

export function OperationFailureRow({
  failure,
  name,
  attemptID,
  outputTail
}: {
  failure: OperationFailure;
  name: string;
  attemptID: string;
  outputTail?: string;
}) {
  const [report, setReport] = useState<ReturnType<typeof operationIssueReport>>();
  const [copyMessage, setCopyMessage] = useState("");
  return (
    <details className="operation-failure">
      <summary>
        {name}: {failure.operation} did not complete{" "}
        <span className="failure-disclosure-label">Show details</span>
      </summary>
      <div className="operation-failure-content">
        <p>{operationFailureDescription(failure)}</p>
        <time dateTime={failure.occurredAt}>{new Date(failure.occurredAt).toLocaleString()}</time>
        <pre className="operation-output" tabIndex={0} aria-label="Command output">
          {outputTail || "No command output is available for this attempt."}
        </pre>
        <p>
          Output is shortened and redacted on a best-effort basis. Check for private information
          before sharing.
        </p>
        <div className="operation-failure-actions">
          <button
            type="button"
            onClick={() => {
              void window.baseline.copyOperationFailure(failure.id, attemptID).then(
                (copied) => setCopyMessage(copied ? "Copied" : "Details are no longer available"),
                () => setCopyMessage("Could not copy details")
              );
            }}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => setReport(operationIssueReport(failure, outputTail))}
          >
            Report issue
          </button>
          <button
            type="button"
            onClick={() => void window.baseline.dismissOperationFailure(failure.id)}
            aria-label={`Dismiss failure for ${name}`}
          >
            Dismiss
          </button>
          <span role="status">{copyMessage}</span>
        </div>
      </div>
      {report && <OperationReportPreview report={report} onClose={() => setReport(undefined)} />}
    </details>
  );
}

export function OperationReportPreview({
  report,
  onClose
}: {
  report: ReturnType<typeof operationIssueReport>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [openError, setOpenError] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") trapFocusWithin(event, dialogRef.current);
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="confirmation-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="confirmation-card operation-report-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operation-report-title"
        aria-describedby="operation-report-warning"
      >
        <h2 id="operation-report-title">Report issue</h2>
        <p id="operation-report-warning">
          Check this text for private information. Redaction is best effort. Nothing is sent until
          you choose Open on GitHub. GitHub opens a bug report form for you to review and submit.
        </p>
        <pre className="operation-output" tabIndex={0} aria-label="Report text">
          {report.text}
        </pre>
        {openError && (
          <p role="alert">Could not open GitHub. You can cancel and copy the details instead.</p>
        )}
        <div className="confirmation-actions">
          <button type="button" className="ghost-button" ref={cancelRef} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              void window.baseline.openExternal(report.url).then(
                (opened) => {
                  if (opened) onClose();
                  else setOpenError(true);
                },
                () => setOpenError(true)
              );
            }}
          >
            Open on GitHub
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
