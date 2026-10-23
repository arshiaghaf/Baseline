// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";

export function suppressCompactPopoverControlFocus(
  target: EventTarget | Element | null,
  compactShell: HTMLElement | null,
  event: React.MouseEvent
): void {
  if (compactPopoverControlFocusTarget(target, compactShell)) {
    // Pointer activation must not leave a previously keyboard-focused action
    // armed while focus is intentionally suppressed on the clicked button.
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && compactShell?.contains(active)) active.blur();
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

export function trapFocusWithin(
  event: KeyboardEvent,
  container: HTMLElement | null,
  includeSearchMenus = false
): void {
  if (event.defaultPrevented || !container) {
    return;
  }

  const focusableElements = focusableElementsIn(container);
  const floatingMenus = includeSearchMenus
    ? Array.from(document.querySelectorAll<HTMLElement>(searchPaletteFloatingRowMenuSelector))
    : [];
  let hasFloatingMenu = false;
  for (const menu of floatingMenus) {
    const triggerIndex = focusableElements.findIndex(
      (element) => element.getAttribute("aria-controls") === menu.id
    );
    if (triggerIndex < 0) continue;
    focusableElements.splice(triggerIndex + 1, 0, ...focusableElementsIn(menu));
    hasFloatingMenu = true;
  }
  if (focusableElements.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }

  const firstElement = focusableElements[0]!;
  const lastElement = focusableElements[focusableElements.length - 1]!;
  const activeElement = document.activeElement;
  // A portal has a different DOM tab order. Keep it next to its owning trigger,
  // and handle traversal explicitly while it is part of this modal scope.
  if (hasFloatingMenu) {
    event.preventDefault();
    const index = focusableElements.indexOf(activeElement as HTMLElement);
    const next =
      index < 0
        ? event.shiftKey
          ? focusableElements.length - 1
          : 0
        : (index + (event.shiftKey ? -1 : 1) + focusableElements.length) % focusableElements.length;
    focusableElements[next]?.focus();
    return;
  }
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
