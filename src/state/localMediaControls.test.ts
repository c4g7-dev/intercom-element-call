/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BehaviorSubject, Subject } from "rxjs";
import { logger } from "matrix-js-sdk/lib/logger";
import { type LocalMediaTrack } from "@element-hq/matrixrtc-sdk";

import {
  followMuteState,
  isDeviceRefusal,
  PUBLISH_RETRY_DELAYS_MS,
  PUBLISH_TIMEOUT_MS,
} from "./localMediaControls";
import { type Handler } from "./MuteStates";
import { ObservableScope } from "./ObservableScope";
import { diagBuffer, resetDiag } from "../diagnostics/diag";

let scope: ObservableScope;

beforeEach(() => {
  vi.useFakeTimers();
  scope = new ObservableScope();
});

afterEach(() => {
  scope.end();
  vi.useRealTimers();
});

function setup(publish: () => Promise<unknown>): {
  handler: () => Handler;
  track$: BehaviorSubject<LocalMediaTrack | undefined>;
  retry$: Subject<void>;
  setEnabled: ReturnType<typeof vi.fn>;
} {
  let handler: Handler | undefined;
  const setEnabled = vi.fn();
  const track$ = new BehaviorSubject<LocalMediaTrack | undefined>(undefined);
  const retry$ = new Subject<void>();
  followMuteState(
    scope,
    {
      setHandler: (h) => (handler = h),
      unsetHandler: () => (handler = undefined),
      enabled$: new BehaviorSubject(true),
      setEnabled$: new BehaviorSubject<((enabled: boolean) => void) | null>(
        setEnabled,
      ),
    },
    track$,
    { publish },
    "microphone",
    logger,
    retry$,
  );
  return { handler: () => handler!, track$, retry$, setEnabled };
}

describe("followMuteState", () => {
  test("publishes when unmuted without a track", async () => {
    const publish = vi.fn(async () => Promise.resolve());
    const { handler } = setup(publish);
    await expect(handler()(true)).resolves.toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  // The mute-on-join bug: the connection is not up yet, the publication
  // throws, and the switch used to flip to muted until the user clicked it.
  test("stays unmuted and retries when the publication fails for lack of a connection", async () => {
    const publish = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("engine not connected within timeout"))
      .mockResolvedValue(undefined);
    const { handler, setEnabled } = setup(publish);

    await expect(handler()(true)).resolves.toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PUBLISH_RETRY_DELAYS_MS[0]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  test("records each attempt and how it ended in the diagnostics", async () => {
    resetDiag();
    const refused = new DOMException("denied", "NotAllowedError");
    const publish = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("not connected"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(refused);
    const { handler } = setup(publish);

    await handler()(true);
    await vi.advanceTimersByTimeAsync(PUBLISH_RETRY_DELAYS_MS[0]);
    await handler()(true);

    expect(
      diagBuffer().map(({ type, source, attempt, ok, outcome }) => ({
        type,
        source,
        attempt,
        ok,
        outcome,
      })),
    ).toEqual([
      { type: "publish_attempt", source: "microphone", attempt: 1 },
      {
        type: "publish_result",
        source: "microphone",
        attempt: 1,
        ok: false,
        outcome: "retry",
      },
      { type: "publish_attempt", source: "microphone", attempt: 2 },
      { type: "publish_result", source: "microphone", attempt: 2, ok: true },
      { type: "publish_attempt", source: "microphone", attempt: 1 },
      {
        type: "publish_result",
        source: "microphone",
        attempt: 1,
        ok: false,
        outcome: "device_refused",
      },
    ]);
    expect(diagBuffer()[1].error).toEqual({
      name: "Error",
      message: "not connected",
    });
  });

  test("retries at once when the participation becomes connected", async () => {
    const publish = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("not connected"))
      .mockResolvedValue(undefined);
    const { handler, retry$ } = setup(publish);

    await handler()(true);
    retry$.next();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(2);
    // The timer that was pending does not publish a second time
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  test("does not retry once the user has muted", async () => {
    const publish = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("not connected"));
    const { handler } = setup(publish);

    await handler()(true);
    await expect(handler()(false)).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test("does not retry once a track has arrived", async () => {
    const publish = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("not connected"));
    const { handler, track$ } = setup(publish);

    await handler()(true);
    track$.next({
      setEnabled: async (enabled) => Promise.resolve(enabled),
      setDevice: async () => Promise.resolve(),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test("treats a publication that never settles as a failed attempt", async () => {
    const publish = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue(undefined);
    const { handler, setEnabled } = setup(publish);

    const result = handler()(true);
    await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS);
    await expect(result).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(PUBLISH_RETRY_DELAYS_MS[0]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  test("flips to muted at once when the device refuses", async () => {
    const publish = vi.fn(async () =>
      Promise.reject(
        new Error("wrapped", {
          cause: new DOMException("denied", "NotAllowedError"),
        }),
      ),
    );
    const { handler } = setup(publish);

    await expect(handler()(true)).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test("gives up and mutes after the last attempt", async () => {
    const publish = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("not connected"));
    const { handler, setEnabled } = setup(publish);

    await handler()(true);
    await vi.advanceTimersByTimeAsync(
      PUBLISH_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1000,
    );
    expect(publish).toHaveBeenCalledTimes(PUBLISH_RETRY_DELAYS_MS.length + 1);
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("isDeviceRefusal", () => {
  test("sees through wrapped errors", () => {
    expect(
      isDeviceRefusal(
        new Error("a", { cause: new DOMException("b", "NotFoundError") }),
      ),
    ).toBe(true);
    expect(isDeviceRefusal(new Error("not connected"))).toBe(false);
    expect(isDeviceRefusal("nope")).toBe(false);
  });
});
