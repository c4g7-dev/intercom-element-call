/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BehaviorSubject, type Observable, type Subscription } from "rxjs";

import { type Behavior } from "./Behavior";

/** A rectangle in the host window, in CSS pixels. */
export type OverlayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OverlaySize = { width: number; height: number };

/**
 * Where the call is while its frame covers the host's window: the place the
 * call had before, and how large the window (and so the frame) is.
 */
export type OverlayPlacement = {
  /** Absent where the call has no place of its own right now. */
  rect?: OverlayRect;
  window: OverlaySize;
};

/** What the host says about the overlay while it is open. */
export type OverlayEvent =
  | { op: "layout"; placement: OverlayPlacement | undefined }
  | { op: "dismiss" };

/**
 * The host's side of the overlay: a host that has one gives the call's frame
 * its whole window for as long as a dialog of the call is open.
 */
export interface HostOverlayChannel {
  /** Resolves to undefined where the host has no overlay to give. */
  open(): Promise<OverlayPlacement | undefined>;
  /** Never rejects. */
  close(): Promise<void>;
  events$: Observable<OverlayEvent>;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function parseSize(value: unknown): OverlaySize | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { width, height } = value as Record<string, unknown>;
  return finite(width) && finite(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

/** Reads what the host sent; anything that is not a placement is none. */
export function parseOverlayPlacement(
  data: unknown,
): OverlayPlacement | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const raw = data as Record<string, unknown>;
  if (raw.supported !== true) return undefined;
  const window = parseSize(raw.window);
  if (window === undefined) return undefined;
  const size = parseSize(raw.rect);
  const { x, y } = (raw.rect ?? {}) as Record<string, unknown>;
  return {
    window,
    ...(size !== undefined &&
      finite(x) &&
      finite(y) && { rect: { x, y, ...size } }),
  };
}

/** Reads a message of the host about the open overlay. */
export function parseOverlayEvent(data: unknown): OverlayEvent | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const op = (data as Record<string, unknown>).op;
  if (op === "dismiss") return { op };
  if (op === "layout") return { op, placement: parseOverlayPlacement(data) };
  return undefined;
}

export type HostOverlayPhase = "closed" | "opening" | "open" | "closing";

export type HostOverlayState = {
  phase: HostOverlayPhase;
  /**
   * Where the call belongs while the frame is the window's size. Kept while
   * closing, until the frame is small again.
   */
  placement?: OverlayPlacement;
};

/**
 * Where the call view is pinned inside its frame: at the place it had in the
 * host's window, once the frame has grown to that window's size. Before the
 * frame grew and after it shrank back the call fills it as always, so
 * neither step is ever drawn with the call in the wrong place, whichever of
 * the host's style change and its message arrives first.
 */
export function overlayPin(
  state: HostOverlayState,
  frame: OverlaySize,
): OverlayRect | undefined {
  const { placement } = state;
  if (placement?.rect === undefined) return undefined;
  const sameSize =
    Math.abs(frame.width - placement.window.width) <= 1 &&
    Math.abs(frame.height - placement.window.height) <= 1;
  return sameSize ? placement.rect : undefined;
}

export interface HostOverlay {
  /**
   * Holds the overlay open for a dialog. Several can hold it at once; the
   * host is asked when the first takes it and told when the last lets go.
   * @param onDismiss called when the host asks for the dialog to go (Escape
   *   pressed outside the call's frame); only the one that took it last is
   *   asked
   * @returns what lets go of it again
   */
  acquire(onDismiss?: () => void): () => void;
  state$: Behavior<HostOverlayState>;
  /** The frame is small again: the pin of a closed overlay can go. */
  settled(): void;
  destroy(): void;
}

/** How long a closed overlay keeps its pin when the frame never shrinks. */
export const OVERLAY_SETTLE_MS = 400;

/**
 * The overlay as the call sees it. Without a channel (standalone, a host
 * that is not InterCom) it stays closed and dialogs open inside the frame as
 * they always did.
 */
export function createHostOverlay(
  channel: HostOverlayChannel | undefined,
  setTimer: (fn: () => void, ms: number) => unknown = setTimeout,
): HostOverlay {
  const state$ = new BehaviorSubject<HostOverlayState>({ phase: "closed" });
  const holders: { onDismiss?: () => void }[] = [];
  // The host is asked in the order things happened, however fast a dialog
  // was opened and closed again
  let queue: Promise<void> = Promise.resolve();
  let generation = 0;
  let subscription: Subscription | undefined;

  const next = (state: HostOverlayState): void => state$.next(state);

  const open = (): void => {
    if (channel === undefined) return;
    const mine = ++generation;
    next({ phase: "opening" });
    queue = queue.then(async () => {
      if (mine !== generation) return;
      let placement: OverlayPlacement | undefined;
      try {
        placement = await channel.open();
      } catch {
        placement = undefined;
      }
      if (mine !== generation) {
        // Let go of while the host was asked
        if (placement !== undefined) await channel.close().catch(() => {});
        return;
      }
      next(
        placement === undefined
          ? { phase: "closed" }
          : { phase: "open", placement },
      );
    });
  };

  const close = (): void => {
    if (channel === undefined) return;
    const mine = ++generation;
    const before = state$.value;
    if (before.phase !== "open") {
      // Never opened: the question still to be put is dropped by its
      // generation, the one being answered closes when it comes back
      next({ phase: "closed" });
      return;
    }
    next({ phase: "closing", placement: before.placement });
    queue = queue.then(async () => {
      await channel.close().catch(() => {});
      setTimer(() => {
        if (mine === generation) settled();
      }, OVERLAY_SETTLE_MS);
    });
  };

  const settled = (): void => {
    if (state$.value.phase === "closing") next({ phase: "closed" });
  };

  subscription = channel?.events$.subscribe((event) => {
    if (event.op === "dismiss") {
      holders.at(-1)?.onDismiss?.();
    } else if (state$.value.phase === "open") {
      // Without a placement the host took the overlay back (the call went
      // to a window of its own): the dialogs stay, inside the frame
      next(
        event.placement === undefined
          ? { phase: "closed" }
          : { phase: "open", placement: event.placement },
      );
    }
  });

  return {
    acquire: (onDismiss) => {
      const holder = { onDismiss };
      holders.push(holder);
      if (holders.length === 1) open();
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        holders.splice(holders.indexOf(holder), 1);
        if (holders.length === 0) close();
      };
    },
    state$,
    settled,
    destroy: (): void => {
      subscription?.unsubscribe();
      subscription = undefined;
      if (holders.length > 0) {
        holders.length = 0;
        close();
      }
    },
  };
}
