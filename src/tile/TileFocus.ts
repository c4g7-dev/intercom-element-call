/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  createContext,
  type MouseEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";

/**
 * Focusing a tile: one click shows it large with the others in a strip beside
 * it, another click (or Escape) goes back. A double click is fullscreen, as it
 * was, so a click waits this long for a second one before it counts.
 */
export const FOCUS_CLICK_DELAY_MS = 220;

/** The name a tile's media is focused by: its kind and its ID. */
export function focusKey(media: { type: string; id: string }): string {
  return `${media.type}:${media.id}`;
}

export interface TileFocus {
  /** Focuses the media of that key, or lets go of it when it is the focused one. */
  toggle: (key: string) => void;
}

/** Set by the call view; absent where tiles cannot be focused (the lobby, a pop-out). */
export const TileFocusContext = createContext<TileFocus | null>(null);

const INTERACTIVE =
  "button, a, input, select, textarea, [role='slider'], [role='menu'], [role='menuitem'], [role='dialog']";

interface FocusClickHandlers {
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  onDoubleClickCapture?: () => void;
}

/**
 * The handlers that make a tile focus its media on a single click.
 * @param key - what to focus, or undefined for a tile that is not focusable
 */
export function useFocusClick(key: string | undefined): FocusClickHandlers {
  const focus = useContext(TileFocusContext);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const onClick = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (focus === null || key === undefined) return;
      if (e.button !== 0 || e.defaultPrevented) return;
      const target = e.target as Element | null;
      // React hands a click in a menu to the tile that opened it, although the
      // menu is not inside the tile; and a button in a tile has its own job
      if (target === null || !e.currentTarget.contains(target)) return;
      if (target.closest(INTERACTIVE) !== null) return;
      // A tile that fills the screen is left with a double click or Escape
      if (document.fullscreenElement) return;
      // The second click of a double click
      if (e.detail > 1) return;
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        focus.toggle(key);
      }, FOCUS_CLICK_DELAY_MS);
    },
    [cancel, focus, key],
  );

  if (focus === null || key === undefined) return {};
  return { onClick, onDoubleClickCapture: cancel };
}
