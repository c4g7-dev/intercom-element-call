/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect, useMemo } from "react";
import { BehaviorSubject, type Observable } from "rxjs";

import { type Behavior } from "../state/Behavior";
import {
  type AloneState,
  type AloneTimeout,
  AloneTimer,
} from "../state/aloneTimer";
import { diag } from "../diagnostics/diag";

export interface AloneTimerHandle {
  /** Where the user stands: see {@link AloneState}. */
  state$: Behavior<AloneState>;
  /** The user wants to stay: the countdown starts over. */
  stay: () => void;
  /** The user left: nothing counts down any more. */
  leave: () => void;
  /** Another timeout was chosen during the call. */
  setTimeout: (timeout: AloneTimeout | undefined) => void;
}

/**
 * Runs the {@link AloneTimer} of a call (InterCom): feeds it who is in the
 * call, wakes it at its deadline, and calls `onExpired` once when the user
 * has been alone for too long.
 *
 * @param timeout What the host asked for; undefined where nothing counts down
 * @param others$ How many others are in the call, by user
 * @param onExpired Leaves the call
 */
export function useAloneTimer(
  timeout: AloneTimeout | undefined,
  others$: Observable<number>,
  onExpired: () => void,
): AloneTimerHandle {
  const handle = useMemo(() => {
    const timer = new AloneTimer({ now: () => Date.now(), timeout });
    const state$ = new BehaviorSubject<AloneState>(timer.state);
    let wake: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const sync = (): void => {
      if (disposed) return;
      const state = timer.state;
      const before = state$.value;
      if (JSON.stringify(state) !== JSON.stringify(before)) {
        diag("alone_timer", {
          state: state.kind,
          ...(state.kind === "alone" && {
            seconds: Math.round((state.deadline - Date.now()) / 1000),
          }),
        });
        state$.next(state);
      }
      if (wake !== undefined) clearTimeout(wake);
      wake = undefined;
      const due = timer.nextDueAt();
      if (due !== undefined)
        wake = setTimeout(sync, Math.max(0, due - Date.now()) + 5);
    };
    return {
      state$,
      told: { expired: false },
      stay: (): void => {
        timer.stay();
        sync();
      },
      leave: (): void => {
        timer.leave();
        sync();
      },
      setTimeout: (next: AloneTimeout | undefined): void => {
        timer.setTimeout(next);
        sync();
      },
      setOthers: (count: number): void => {
        timer.setOthers(count);
        sync();
      },
      dispose: (): void => {
        disposed = true;
        if (wake !== undefined) clearTimeout(wake);
      },
    };
    // The timeout of the URL is where the timer starts; later ones come by
    // setTimeout
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => handle.dispose, [handle]);

  useEffect(() => {
    const subscription = others$.subscribe(handle.setOthers);
    return (): void => subscription.unsubscribe();
  }, [others$, handle]);

  useEffect(() => {
    const subscription = handle.state$.subscribe((state) => {
      // Once, also where this is subscribed to again after it
      if (state.kind !== "expired" || handle.told.expired) return;
      handle.told.expired = true;
      onExpired();
    });
    return (): void => subscription.unsubscribe();
  }, [handle, onExpired]);

  return handle;
}
