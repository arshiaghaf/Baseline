// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";

export function clearCompactPopoverControlFocus(
  target: EventTarget | Element | null,
  compactShell: HTMLElement | null
): void {
  const focusTarget = compactPopoverControlFocusTarget(target, compactShell);
  if (!focusTarget) {
    return;
  }
  focusTarget.blur();
}

export function suppressCompactPopoverControlFocus(
  target: EventTarget | Element | null,
  compactShell: HTMLElement | null,
  event: React.MouseEvent
): void {
  if (compactPopoverControlFocusTarget(target, compactShell)) {
    event.preventDefault();
  }
}

export function compactPopoverControlFocusTarget(
  target: EventTarget | Element | null,
  compactShell: HTMLElement | null
): HTMLElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }
  if (target.closest("[data-compact-focus]")) {
    return undefined;
  }
  const focusTarget = target.closest("button, input, textarea, [contenteditable='true']");
  if (!(focusTarget instanceof HTMLElement)) {
    return undefined;
  }
  if (compactShell && !compactShell.contains(focusTarget)) {
    return undefined;
  }
  if (focusTarget.matches("input, textarea, [contenteditable='true']")) {
    return undefined;
  }
  return focusTarget;
}

export function setElementInert(element: HTMLElement, inert: boolean): void {
  (element as HTMLElement & { inert: boolean }).inert = inert;
}

export const focusableSelector = [
  "a[href]:not([tabindex='-1'])",
  "button:not(:disabled):not([tabindex='-1'])",
  "input:not(:disabled):not([tabindex='-1'])",
  "select:not(:disabled):not([tabindex='-1'])",
  "textarea:not(:disabled):not([tabindex='-1'])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function focusableElementsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
    .filter(
      (element) =>
        !element.closest("[aria-hidden='true']") &&
        element.getAttribute("tabindex") !== "-1" &&
        element.tabIndex >= 0
    )
    .sort(compareDocumentOrder);
}

export function compareDocumentOrder(lhs: HTMLElement, rhs: HTMLElement): number {
  if (lhs === rhs) {
    return 0;
  }
  const position = lhs.compareDocumentPosition(rhs);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
    return -1;
  }
  if (position & Node.DOCUMENT_POSITION_PRECEDING) {
    return 1;
  }
  return 0;
}

export function trapFocusWithin(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) {
    return;
  }

  const focusableElements = focusableElementsIn(container);
  if (focusableElements.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }

  const firstElement = focusableElements[0]!;
  const lastElement = focusableElements[focusableElements.length - 1]!;
  const activeElement = document.activeElement;
  if (event.shiftKey) {
    if (activeElement === firstElement || !container.contains(activeElement)) {
      event.preventDefault();
      lastElement.focus();
    }
    return;
  }

  if (activeElement === lastElement || !container.contains(activeElement)) {
    event.preventDefault();
    firstElement.focus();
  }
}

export const searchPaletteFloatingRowMenuSelector =
  "[data-search-palette-floating-row-menu='true'][role='menu']";

export function hasOpenNestedMenu(container: HTMLElement | null): boolean {
  return Boolean(
    container?.querySelector("[role='menu']") ||
    document.querySelector(searchPaletteFloatingRowMenuSelector)
  );
}
