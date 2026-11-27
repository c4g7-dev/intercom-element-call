/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { act, renderHook } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAloneTimer } from "./useAloneTimer";
import { type AloneTimeout } from "../state/aloneTimer";

describe("useAloneTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setUp(timeout: AloneTimeout | undefined): {
    others$: BehaviorSubject<number>;
    onExpired: ReturnType<typeof vi.fn>;
    hook: ReturnType<
      typeof renderHook<ReturnType<typeof useAloneTimer>, unknown>
    >;
  } {
    const others$ = new BehaviorSubject(0);
    const onExpired = vi.fn<() => void>();
    const hook = renderHook(() => useAloneTimer(timeout, others$, onExpired));
    return { others$, onExpired, hook };
  }

  it("leaves once when the user has been alone for the whole timeout", () => {
    const { others$, onExpired, hook } = setUp(180);
    expect(hook.result.current.state$.value.kind).toBe("waiting-for-others");
    act(() => void vi.advanceTimersByTime(600_000));
    expect(onExpired).not.toHaveBeenCalled();

    act(() => others$.next(1));
    expect(hook.result.current.state$.value.kind).toBe("with-others");
    act(() => others$.next(0));
    expect(hook.result.current.state$.value.kind).toBe("alone");
    act(() => void vi.advanceTimersByTime(179_000));
    expect(onExpired).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1_100));
    expect(hook.result.current.state$.value.kind).toBe("expired");
    expect(onExpired).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(600_000));
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("stays, takes another timeout, and forgets it all when somebody is back", () => {
    const { others$, onExpired, hook } = setUp(180);
    act(() => others$.next(1));
    act(() => others$.next(0));
    act(() => void vi.advanceTimersByTime(170_000));
    act(() => hook.result.current.stay());
    act(() => void vi.advanceTimersByTime(170_000));
    expect(onExpired).not.toHaveBeenCalled();
    act(() => hook.result.current.setTimeout(600));
    act(() => void vi.advanceTimersByTime(590_000));
    expect(onExpired).not.toHaveBeenCalled();
    act(() => others$.next(1));
    act(() => void vi.advanceTimersByTime(3_600_000));
    expect(onExpired).not.toHaveBeenCalled();
    expect(hook.result.current.state$.value.kind).toBe("with-others");
  });

  it("does nothing without a timeout, with never, after leaving or unmounted", () => {
    for (const timeout of [undefined, "never" as const]) {
      const { others$, onExpired } = setUp(timeout);
      act(() => others$.next(1));
      act(() => others$.next(0));
      act(() => void vi.advanceTimersByTime(3_600_000));
      expect(onExpired).not.toHaveBeenCalled();
    }
    const left = setUp(180);
    act(() => left.others$.next(1));
    act(() => left.others$.next(0));
    act(() => left.hook.result.current.leave());
    act(() => void vi.advanceTimersByTime(3_600_000));
    expect(left.onExpired).not.toHaveBeenCalled();

    const gone = setUp(180);
    act(() => gone.others$.next(1));
    act(() => gone.others$.next(0));
    gone.hook.unmount();
    act(() => void vi.advanceTimersByTime(3_600_000));
    expect(gone.onExpired).not.toHaveBeenCalled();
  });
});
