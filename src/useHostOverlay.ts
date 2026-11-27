/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect, useRef } from "react";

import { type HostBridge, useHostBridge } from "./HostBridge";
import {
  createHostOverlay,
  type HostOverlay,
  type OverlayRect,
  overlayPin,
} from "./state/hostOverlay";
import { useRootElement } from "./RootElementContext";
import { diag } from "./diagnostics/diag";

const overlays = new WeakMap<HostBridge, HostOverlay>();

/** The one overlay of a host: every dialog of the call shares it. */
export function hostOverlayOf(bridge: HostBridge): HostOverlay {
  let overlay = overlays.get(bridge);
  if (overlay === undefined) {
    overlay = createHostOverlay(bridge.overlay);
    overlays.set(bridge, overlay);
  }
  return overlay;
}

/**
 * Asks the host for its whole window while a dialog is open, so that the
 * dialog is not confined to the part of the window the call has. Where the
 * host has none to give, nothing changes.
 * @param onDismiss the host's request to close the dialog (Escape pressed
 *   while the focus was not in the call)
 */
export function useHostOverlay(open: boolean, onDismiss?: () => void): void {
  const overlay = hostOverlayOf(useHostBridge());
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    if (!open) return;
    return overlay.acquire(() => dismiss.current?.());
  }, [open, overlay]);
}

/** The attribute the stylesheet pins the call view by, on the page's root. */
export const OVERLAY_PIN_ATTRIBUTE = "data-intercom-overlay";

/** Marks the page as pinned and says where, or takes the mark away. */
export function applyOverlayPin(
  doc: Document,
  pin: OverlayRect | undefined,
): void {
  const root = doc.documentElement;
  if (pin === undefined) {
    root.removeAttribute(OVERLAY_PIN_ATTRIBUTE);
    for (const name of ["x", "y", "width", "height"])
      root.style.removeProperty(`--intercom-pin-${name}`);
    return;
  }
  root.setAttribute(OVERLAY_PIN_ATTRIBUTE, "pinned");
  for (const [name, value] of Object.entries(pin))
    root.style.setProperty(`--intercom-pin-${name}`, `${value}px`);
}

/**
 * Keeps the call view where it was in the host's window while the call's
 * frame covers that window for a dialog: the call does not move or change
 * its size, and what is around it in the frame is see-through, so the host
 * shows under the dialog's backdrop. Mounted once, at the top of the app.
 */
export function useHostOverlayPin(): void {
  const overlay = hostOverlayOf(useHostBridge());
  const doc = useRootElement().ownerDocument;
  useEffect(() => {
    const view = doc.defaultView;
    if (view === null) return;
    let pinned = false;
    const update = (): void => {
      const state = overlay.state$.value;
      const pin = overlayPin(state, {
        width: view.innerWidth,
        height: view.innerHeight,
      });
      applyOverlayPin(doc, pin);
      if (pinned !== (pin !== undefined)) {
        pinned = pin !== undefined;
        diag("host_overlay", { pinned, phase: state.phase });
      }
      // Closed and small again: nothing is left to keep in place
      if (state.phase === "closing" && pin === undefined) overlay.settled();
    };
    const subscription = overlay.state$.subscribe(update);
    view.addEventListener("resize", update);
    return (): void => {
      subscription.unsubscribe();
      view.removeEventListener("resize", update);
      applyOverlayPin(doc, undefined);
    };
  }, [overlay, doc]);
}
