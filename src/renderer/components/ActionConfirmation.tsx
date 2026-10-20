// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import { homebrewPresentationLabel } from "../../shared/domain";
import { trapFocusWithin } from "../helpers/focus";
import type { RequestActionConfirmation, ActionConfirmation } from "../types";

export const ActionConfirmationContext = React.createContext<RequestActionConfirmation>(() => {});

export function ActionConfirmationOverlay({
  confirmation,
  onCancel,
  onConfirm,
  returnFocusElement
}: {
  confirmation: ActionConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusElement: HTMLElement | null;
}) {
  const dialogRef = React.useRef<HTMLElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const closeRef = React.useRef(onCancel);
  closeRef.current = onCancel;
  React.useEffect(() => {
    cancelRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        trapFocusWithin(event, dialogRef.current);
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      if (
        returnFocusElement?.isConnected &&
        returnFocusElement.tabIndex >= 0 &&
        !returnFocusElement.closest("[inert], [aria-hidden='true']")
      ) {
        returnFocusElement.focus();
      }
    };
  }, [returnFocusElement]);

  const isDestructive = confirmation.type === "uninstall";
  const title =
    confirmation.type === "install"
      ? `Install ${confirmation.item.displayName}?`
      : `Uninstall ${confirmation.item.name}?`;
  const message =
    confirmation.type === "install"
      ? `This will run Homebrew and install ${confirmation.item.displayName} (${homebrewPresentationLabel(
          confirmation.item.kind,
          confirmation.item.presentation
        )} ${confirmation.item.token}) on your Mac.`
      : "This will fully delete the item from your Mac. Do you want to proceed?";
  const actionTitle =
    confirmation.type === "install"
      ? `Install ${confirmation.item.displayName}`
      : `Uninstall ${confirmation.item.name}`;

  return (
    <div className="confirmation-backdrop" role="presentation" onClick={onCancel}>
      <section
        ref={dialogRef}
        className="confirmation-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <h2 id="confirmation-title">{title}</h2>
          <p>{message}</p>
        </div>
        <div className="confirmation-actions">
          <button
            className={isDestructive ? "destructive-text-button" : "primary-button wide"}
            onClick={onConfirm}
          >
            {actionTitle}
          </button>
          <button className="ghost-button wide" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
