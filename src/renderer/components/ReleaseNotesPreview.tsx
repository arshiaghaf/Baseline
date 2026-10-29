// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ListChecks, X } from "lucide-react";
import { baseline } from "../ipc";
import type { ReleaseNotesResult, ReleaseNotesTarget } from "../../shared/releaseNotes";

const openEvent = "baseline:release-notes-open";
const hoverDelay = 600;
const leaveDelay = 180;

type PreviewState = { result?: ReleaseNotesResult; loading: boolean };
type PreviewProps = {
  target?: ReleaseNotesTarget;
  title: string;
  sourceKey?: string;
  canRequestNotes?: boolean;
  children: React.ReactNode | ((trigger: React.ReactNode) => React.ReactNode);
};

export function dismissReleaseNotesPreviews() {
  document.dispatchEvent(new CustomEvent(openEvent));
}

/** Read-only presentation. Main resolves sources and validates every request and external URL. */
export function ReleaseNotesPreview(props: PreviewProps) {
  return props.target?.version.trim() && props.canRequestNotes !== false ? (
    <AvailableReleaseNotesPreview {...props} target={props.target} />
  ) : (
    <>{typeof props.children === "function" ? props.children(null) : props.children}</>
  );
}

function AvailableReleaseNotesPreview({
  target,
  title,
  sourceKey = "",
  children
}: PreviewProps & { target: ReleaseNotesTarget }) {
  const instanceID = useId();
  const dialogID = `release-notes-${instanceID}`;
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const insideAnchor = useRef(false);
  const insidePanel = useRef(false);
  const active = useRef(false);
  const explicit = useRef(false);
  const generation = useRef(0);
  const requestID = useRef<string | undefined>(undefined);
  const [state, setState] = useState<PreviewState>();
  const [absentKey, setAbsentKey] = useState<string>();
  const [position, setPosition] = useState<React.CSSProperties>({});
  const targetKey = JSON.stringify([
    target?.kind,
    target?.id,
    target?.version,
    target?.buildVersion,
    sourceKey
  ]);
  const current = useRef({ target, title });
  current.current = { target, title };

  const cancelRequest = useCallback(() => {
    generation.current++;
    const previous = requestID.current;
    requestID.current = undefined;
    if (previous) void baseline.cancelReleaseNotes(previous).catch(() => undefined);
  }, []);

  const clearTimers = useCallback(() => {
    clearTimeout(hoverTimer.current);
    clearTimeout(leaveTimer.current);
    hoverTimer.current = undefined;
    leaveTimer.current = undefined;
  }, []);

  const close = useCallback(
    (restoreFocus = false) => {
      clearTimers();
      cancelRequest();
      const shouldRestore =
        restoreFocus &&
        (explicit.current || Boolean(panel.current?.contains(document.activeElement)));
      active.current = false;
      explicit.current = false;
      insideAnchor.current = false;
      insidePanel.current = false;
      setState(undefined);
      if (shouldRestore) (trigger.current ?? anchor.current)?.focus({ preventScroll: true });
    },
    [cancelRequest, clearTimers]
  );

  const dismissFocusedPanel = useCallback(() => {
    close(Boolean(panel.current?.contains(document.activeElement)));
  }, [close]);

  const load = useCallback(
    (force = false) => {
      const { target: requestedTarget, title: requestedTitle } = current.current;
      if (!requestedTarget) return;
      if (force && explicit.current) closeButton.current?.focus({ preventScroll: true });
      cancelRequest();
      const token = generation.current;
      const id = `${dialogID}-${token}`;
      requestID.current = id;
      setState({ loading: true });
      void baseline.getReleaseNotes({ requestID: id, target: requestedTarget, force }).then(
        (result) => {
          if (active.current && generation.current === token) {
            requestID.current = undefined;
            const empty =
              result.status === "available" && !result.blocks?.some((block) => block.text.trim());
            if ((result.status === "unavailable" && !result.retryable) || empty)
              setAbsentKey(targetKey);
            else setAbsentKey(undefined);
            if (empty)
              result = {
                ...result,
                status: "unavailable",
                message: "Release notes aren’t available for this version."
              };
            setState({ result, loading: false });
          }
        },
        () => {
          if (active.current && generation.current === token) {
            requestID.current = undefined;
            setState({
              loading: false,
              result: {
                status: "error",
                title: requestedTitle,
                version: requestedTarget.version,
                message: "Release notes could not be loaded. Try again."
              }
            });
          }
        }
      );
    },
    [cancelRequest, dialogID, targetKey]
  );

  const open = useCallback(
    (fromAction: boolean) => {
      clearTimers();
      if (!current.current.target) return;
      if (absentKey === targetKey) return;
      if (!fromAction && document.activeElement?.closest(".release-notes-panel")) return;
      if (active.current) {
        if (fromAction) {
          explicit.current = true;
          closeButton.current?.focus({ preventScroll: true });
        }
        return;
      }
      document.dispatchEvent(new CustomEvent(openEvent, { detail: instanceID }));
      const rect = anchor.current?.getBoundingClientRect();
      const margin = 12;
      const width = Math.min(390, window.innerWidth - margin * 2);
      const below = window.innerHeight - (rect?.bottom ?? margin) - margin - 8;
      const above = (rect?.top ?? margin) - margin - 8;
      const useBelow = below >= 180 || below >= above;
      const maxHeight = Math.max(
        120,
        Math.min(440, useBelow ? below : above, window.innerHeight - margin * 2)
      );
      setPosition({
        width,
        maxHeight,
        left: Math.max(margin, Math.min(rect?.left ?? margin, window.innerWidth - width - margin)),
        top: useBelow
          ? Math.max(
              margin,
              Math.min((rect?.bottom ?? margin) + 8, window.innerHeight - maxHeight - margin)
            )
          : Math.max(margin, (rect?.top ?? margin) - maxHeight - 8)
      });
      active.current = true;
      explicit.current = fromAction;
      load();
    },
    [clearTimers, instanceID, load, absentKey, targetKey]
  );

  const scheduleClose = useCallback(() => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      if (
        !insideAnchor.current &&
        !insidePanel.current &&
        !anchor.current?.contains(document.activeElement) &&
        !panel.current?.contains(document.activeElement) &&
        !explicit.current
      )
        close();
    }, leaveDelay);
  }, [close]);

  useLayoutEffect(() => {
    if (state && explicit.current) closeButton.current?.focus({ preventScroll: true });
  }, [Boolean(state)]);

  useLayoutEffect(() => {
    dismissFocusedPanel();
    insideAnchor.current = false;
    insidePanel.current = false;
    const onOtherOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== instanceID) close();
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target))
        dismissFocusedPanel();
    };
    const onBlur = () => close();
    document.addEventListener(openEvent, onOtherOpen);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismissFocusedPanel);
    window.addEventListener("blur", onBlur);
    window.addEventListener("hashchange", onBlur);
    return () => {
      document.removeEventListener(openEvent, onOtherOpen);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismissFocusedPanel);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("hashchange", onBlur);
      active.current = false;
      clearTimers();
      cancelRequest();
    };
  }, [targetKey, close, dismissFocusedPanel, cancelRequest, clearTimers, instanceID]);

  useEffect(() => {
    if (!state) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [Boolean(state), close]);

  const result = state?.result;
  const notesTrigger =
    absentKey === targetKey ? null : (
      <button
        className="release-notes-trigger"
        ref={trigger}
        type="button"
        title="Release notes"
        aria-label={`Release notes for ${title}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(state)}
        aria-controls={state ? dialogID : undefined}
        aria-busy={state?.loading || undefined}
        onClick={() => open(true)}
      >
        <ListChecks size={15} aria-hidden="true" />
      </button>
    );
  return (
    <div
      className="release-notes-anchor"
      ref={anchor}
      tabIndex={-1}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        insideAnchor.current = true;
        clearTimeout(leaveTimer.current);
        if (!active.current && !hoverTimer.current) {
          hoverTimer.current = setTimeout(() => {
            hoverTimer.current = undefined;
            open(false);
          }, hoverDelay);
        }
      }}
      onPointerLeave={() => {
        insideAnchor.current = false;
        clearTimeout(hoverTimer.current);
        hoverTimer.current = undefined;
        scheduleClose();
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          (anchor.current?.contains(event.relatedTarget) ||
            panel.current?.contains(event.relatedTarget))
        )
          return;
        if (active.current && explicit.current) close();
        else scheduleClose();
      }}
    >
      {typeof children === "function" ? (
        children(notesTrigger)
      ) : (
        <>
          {children}
          {notesTrigger}
        </>
      )}
      {state &&
        createPortal(
          <section
            id={dialogID}
            ref={panel}
            className="release-notes-panel"
            role="dialog"
            aria-modal="false"
            aria-labelledby={`${dialogID}-title`}
            style={position}
            onPointerEnter={() => {
              insidePanel.current = true;
              clearTimeout(leaveTimer.current);
            }}
            onPointerLeave={() => {
              insidePanel.current = false;
              scheduleClose();
            }}
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                (panel.current?.contains(event.relatedTarget) ||
                  anchor.current?.contains(event.relatedTarget))
              )
                return;
              if (explicit.current) close();
              else scheduleClose();
            }}
          >
            <header className="release-notes-header">
              <div>
                <h2 id={`${dialogID}-title`}>Release notes</h2>
                <p>
                  {title} <span className="release-notes-version">{target.version}</span>
                </p>
              </div>
              <button
                type="button"
                className="release-notes-close"
                ref={closeButton}
                aria-label="Close release notes"
                onClick={() => close(true)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <div
              className="release-notes-body"
              tabIndex={0}
              aria-label="Release notes content"
              aria-busy={state.loading}
            >
              {state.loading ? (
                <p role="status">Loading release notes…</p>
              ) : result?.status === "available" ? (
                <>
                  {result.source && <p className="release-notes-source">From {result.source}</p>}
                  {result.message && <p className="release-notes-notice">{result.message}</p>}
                  {result.blocks?.map((block, index) =>
                    block.type === "heading" ? (
                      <h3 key={index}>{block.text}</h3>
                    ) : (
                      <p
                        key={index}
                        className={
                          block.type === "list-item" ? "release-notes-list-item" : undefined
                        }
                      >
                        {block.type === "list-item" ? "• " : ""}
                        {block.text}
                      </p>
                    )
                  )}
                </>
              ) : (
                <div role="status">
                  <h3>
                    {result?.status === "error"
                      ? "Couldn’t load release notes"
                      : "Release notes unavailable"}
                  </h3>
                  <p>{result?.message ?? "No release notes were found for this version."}</p>
                </div>
              )}
            </div>
            <footer className="release-notes-footer">
              {result?.status === "error" && (
                <button type="button" onClick={() => load(true)}>
                  Try again
                </button>
              )}
            </footer>
          </section>,
          document.body
        )}
    </div>
  );
}
