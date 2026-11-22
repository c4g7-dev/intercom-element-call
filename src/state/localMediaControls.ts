/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type Behavior,
  type LocalMediaTrack,
  type LocalVideoMediaTrack,
  type ObservableScope,
  type VideoProcessor,
} from "@element-hq/matrixrtc-sdk";
import { type Logger } from "matrix-js-sdk/lib/logger";
import { combineLatest, NEVER, type Observable } from "rxjs";

import { type MediaDevice } from "./MediaDevices";
import { type Handler } from "./MuteStates";

/** How a mute switch gets a track where there is none. */
export interface TrackSupply {
  publish: () => Promise<unknown>;
  /** Awaited before a switch turned on acts: a camera waits for its processor to be known. */
  ready?: () => Promise<unknown>;
}

/** How long to wait before each new attempt at a publication that failed. */
export const PUBLISH_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

/**
 * Whether the device itself refused: a denied permission, a missing or busy
 * device. Trying again would only ask the same question, so the switch flips
 * back. Anything else (typically a connection that is not up yet) is worth
 * another attempt.
 */
export function isDeviceRefusal(e: unknown): boolean {
  for (let cause: unknown = e, depth = 0; depth < 5; depth++) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "name" in cause &&
      typeof cause.name === "string" &&
      [
        "NotAllowedError",
        "NotFoundError",
        "NotReadableError",
        "OverconstrainedError",
        "SecurityError",
      ].includes(cause.name)
    )
      return true;
    if (!(cause instanceof Error) || cause.cause === undefined) return false;
    cause = cause.cause;
  }
  return false;
}

/**
 * The mute switch drives the track, which reports back what the device
 * allowed, so a denied permission flips the switch back. A source is muted
 * and unmuted while its track exists and published when it does not.
 *
 * A publication that fails for any reason other than the device refusing
 * (the media connection not being up yet, most of the time) leaves the switch
 * on, as the user asked, and is attempted again: after a delay and whenever
 * `retry$` emits (the participation becoming connected). Only once every
 * attempt has failed does the switch flip to off.
 */
export function followMuteState(
  scope: ObservableScope,
  muteState: {
    setHandler: (handler: Handler) => void;
    unsetHandler: () => void;
    enabled$: Behavior<boolean>;
    setEnabled$?: Behavior<((enabled: boolean) => void) | null>;
  },
  track$: Behavior<LocalMediaTrack | undefined>,
  supply: TrackSupply,
  source: "microphone" | "camera",
  logger: Logger,
  retry$: Observable<unknown> = NEVER,
): void {
  // What the switch asks for, ahead of what it shows: the switch follows
  // only once the handler has resolved
  let desired = muteState.enabled$.value;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let publishing = false;
  const cancelRetry = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const giveUp = (): void => {
    cancelRetry();
    attempts = 0;
    desired = false;
    muteState.setEnabled$?.value?.(false);
  };
  /** Resolves with whether the switch may stay on. */
  const publish = async (): Promise<boolean> => {
    if (publishing) return true;
    publishing = true;
    cancelRetry();
    try {
      await supply.publish();
      attempts = 0;
      return true;
    } catch (e) {
      if (isDeviceRefusal(e)) {
        logger.error(`Failed to publish the ${source}`, e);
        attempts = 0;
        return false;
      }
      const delay = PUBLISH_RETRY_DELAYS_MS[attempts++];
      if (delay === undefined) {
        logger.error(`Failed to publish the ${source}, giving up`, e);
        attempts = 0;
        return false;
      }
      logger.warn(
        `Failed to publish the ${source}, staying unmuted and retrying in ${delay}ms`,
        e,
      );
      retryTimer = setTimeout(retry, delay);
      return true;
    } finally {
      publishing = false;
    }
  };
  const retry = (): void => {
    // Only a pending retry is brought forward or run
    if (retryTimer === undefined) return;
    cancelRetry();
    if (!desired || track$.value !== undefined) {
      attempts = 0;
      return;
    }
    void publish().then((keep) => {
      if (!keep && desired) giveUp();
    });
  };
  retry$.pipe(scope.bind()).subscribe(() => retry());
  scope.onEnd(cancelRetry);

  muteState.setHandler(async (enabled) => {
    desired = enabled;
    if (!enabled) {
      cancelRetry();
      attempts = 0;
    }
    if (enabled) await supply.ready?.();
    const track = track$.value;
    if (track !== undefined) {
      desired = await track.setEnabled(enabled);
      return desired;
    }
    if (!enabled) return false;
    desired = await publish();
    return desired;
  });
  scope.onEnd(() => muteState.unsetHandler());
  // A track that arrives after its switch was flipped off catches up with it
  track$.pipe(scope.bind()).subscribe((track) => {
    if (track !== undefined && !desired)
      track.setEnabled(false).catch((e) => {
        logger.error(`Failed to mute the ${source}`, e);
      });
  });
}

/**
 * The device the user picked follows onto the track as it is made and as the
 * choice changes; the SDK does not watch the settings itself.
 */
export function followDevice(
  scope: ObservableScope,
  track$: Behavior<LocalMediaTrack | undefined>,
  device: MediaDevice<unknown, { id: string }>,
  source: "microphone" | "camera",
  logger: Logger,
): void {
  combineLatest([track$, device.selected$])
    .pipe(scope.bind())
    .subscribe(([track, selected]) => {
      if (track === undefined || selected === undefined) return;
      track.setDevice(selected.id).catch((e) => {
        logger.error(`Failed to switch the ${source} device`, e);
      });
    });
}

/**
 * Attached once the camera track exists rather than carried in the publish
 * request, so that a new track and a change of processor take the same path.
 * Answers with a wait for the latest attachment to have gone through: a
 * camera turned on before then would restart without its processor.
 */
export function followProcessor(
  scope: ObservableScope,
  camera$: Behavior<LocalVideoMediaTrack | undefined>,
  videoProcessor$: Behavior<VideoProcessor | undefined>,
  logger: Logger,
): () => Promise<void> {
  let attached = Promise.resolve();
  combineLatest([camera$, videoProcessor$])
    .pipe(scope.bind())
    .subscribe(([camera, processor]) => {
      attached =
        camera?.setProcessor(processor).catch((e) => {
          logger.error("Failed to set the video processor", e);
        }) ?? Promise.resolve();
    });
  return async () => attached;
}
