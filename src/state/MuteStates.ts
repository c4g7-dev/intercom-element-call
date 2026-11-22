/*
Copyright 2023-2025 New Vector Ltd.
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/lib/logger";
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  firstValueFrom,
  map,
  merge,
  Observable,
  of,
  Subject,
  switchMap,
  withLatestFrom,
} from "rxjs";

import { type MediaDevices, type MediaDevice } from "../state/MediaDevices";
import { type DeviceMuteState, type HostBridge } from "../HostBridge";
import { type ObservableScope } from "./ObservableScope";
import { type Behavior, constant } from "./Behavior";
import { diag } from "../diagnostics/diag";

interface MuteStateData {
  enabled$: Observable<boolean>;
  syncing$: Observable<boolean>;
  set: ((enabled: boolean) => void) | null;
  toggle: (() => void) | null;
}

export type Handler = (desired: boolean) => Promise<boolean>;
const defaultHandler: Handler = async (desired) => Promise.resolve(desired);

/**
 * Internal class - exported only for testing purposes.
 * Do not use directly outside of tests.
 */
export class MuteState<Label, Selected> {
  private readonly handler$ = new BehaviorSubject(defaultHandler);

  public setHandler(handler: Handler): void {
    if (this.handler$.value !== defaultHandler)
      throw new Error("Multiple mute state handlers are not supported");
    this.handler$.next(handler);
  }

  public unsetHandler(): void {
    this.handler$.next(defaultHandler);
  }

  private devicesConnectedBefore = false;
  /**
   * What the user last asked for, kept across the device going away so that
   * it can be restored when the device comes back (see `restoreOnReturn`).
   */
  private lastWanted: boolean | undefined = undefined;

  private readonly canControlDevices$ = combineLatest([
    this.device.available$,
    this.forceMute$,
  ]).pipe(
    map(([available, forceMute]) => {
      return !forceMute && available.size > 0;
    }),
  );

  private readonly data$ = this.scope.behavior<MuteStateData>(
    this.canControlDevices$.pipe(
      distinctUntilChanged(),
      map((canControlDevices) => {
        logger.info(
          `MuteState: canControlDevices: ${canControlDevices}, enabled by default: ${this.enabledByDefault}`,
        );
        if (!canControlDevices) {
          logger.info(
            `MuteState: devices connected: ${canControlDevices}, disabling`,
          );
          if (this.devicesConnectedBefore) this.record(false, "device_lost");
          else this.record(false, "no_device");
          // We need to sync the mute state with the handler
          // to ensure nothing is beeing published.
          this.handler$.value(false).catch((err) => {
            logger.error("MuteState-disable: handler error", err);
          });
          return {
            enabled$: of(false),
            syncing$: of(false),
            set: null,
            toggle: null,
          };
        }

        // defaultHander = no-op hanlder = "no actual device handler available"
        const handlerAttached = this.handler$.value !== defaultHandler;
        const deviceCameBackInCall =
          handlerAttached && this.devicesConnectedBefore;
        // Set the flag. A marker, that we reached this code before.
        this.devicesConnectedBefore = true;
        // A device that comes back during a call returns to what the user had
        // asked for before it went away where that is wanted (the
        // microphone: a headset that reconnects must not leave the user
        // silently muted), and stays off otherwise (the camera: one that is
        // plugged in must not start sending video unasked).
        const initialWanted = deviceCameBackInCall
          ? this.restoreOnReturn && (this.lastWanted ?? this.enabledByDefault)
          : this.enabledByDefault;
        this.lastWanted = initialWanted;
        this.record(
          initialWanted,
          deviceCameBackInCall ? "device_returned" : "initial",
          { handlerAttached },
        );
        // With a handler attached we start off and let the sync below actually call
        // the handler, so the switch shows "on" only once the track is really there.
        // Without one (lobby) enabled = initialWanted -> no call to handler.
        let enabled = handlerAttached ? false : initialWanted;
        const set$ = new Subject<boolean>();
        const toggle$ = new Subject<void>();
        const syncing$ = new BehaviorSubject(false);
        const desired$ = merge(set$, toggle$.pipe(map(() => !enabled)));
        const enabled$ = new Observable<boolean>((subscriber) => {
          subscriber.next(enabled);
          let latestDesired = initialWanted;

          const sync = async (): Promise<void> => {
            if (enabled === latestDesired) {
              syncing$.next(false);
            } else {
              const previouslyEnabled = enabled;
              syncing$.next(true);
              enabled = await firstValueFrom(
                this.handler$.pipe(
                  switchMap(async (handler) => handler(latestDesired)),
                ),
              );
              // The handler has the last word: a refusal is what is wanted now
              if (enabled !== latestDesired) this.lastWanted = enabled;
              this.record(
                enabled,
                enabled === latestDesired ? "applied" : "handler_refused",
                { asked: latestDesired },
              );
              if (enabled === previouslyEnabled) {
                syncing$.next(false);
              } else {
                subscriber.next(enabled);
                syncing$.next(true);
                sync().catch((err) => {
                  // TODO: better error handling
                  logger.error("MuteState: handler error", err);
                });
              }
            }
          };

          const startSync = (): void => {
            syncing$.next(true);
            sync().catch((err) => {
              // TODO: better error handling
              logger.error("MuteState: handler error", err);
            });
          };

          const s = desired$.subscribe((desired) => {
            latestDesired = desired;
            this.lastWanted = desired;
            this.record(desired, "user");
            if (syncing$.value === false) startSync();
          });
          if (enabled !== latestDesired) startSync();
          return (): void => {
            s.unsubscribe();
            syncing$.complete();
          };
        });

        return {
          set: (enabled: boolean): void => set$.next(enabled),
          toggle: (): void => {
            if (syncing$.value) return;
            toggle$.next();
          },
          enabled$,
          syncing$,
        };
      }),
    ),
  );

  public readonly enabled$: Behavior<boolean> = this.scope.behavior(
    this.data$.pipe(switchMap(({ enabled$ }) => enabled$)),
  );

  public readonly setEnabled$: Behavior<((enabled: boolean) => void) | null> =
    this.scope.behavior(this.data$.pipe(map(({ set }) => set)));

  public readonly toggle$: Behavior<(() => void) | null> = this.scope.behavior(
    this.data$.pipe(map(({ toggle }) => toggle)),
  );

  public readonly syncing$: Behavior<boolean> = this.scope.behavior(
    this.data$.pipe(switchMap(({ syncing$ }) => syncing$)),
  );

  public constructor(
    private readonly scope: ObservableScope,
    private readonly device: MediaDevice<Label, Selected>,
    private readonly enabledByDefault: boolean,
    /**
     * An optional observable which, when it emits `true`, will force the mute.
     * Used for video to stop camera when earpiece mode is on.
     * @private
     */
    private readonly forceMute$: Observable<boolean>,
    /**
     * Whether a device that comes back during a call (under a handler)
     * returns to the state the user last asked for, rather than to off.
     */
    private readonly restoreOnReturn = false,
    /** What this switch is called in the diagnostics; unrecorded without. */
    private readonly diagSource?: "microphone" | "camera",
  ) {}

  /**
   * `user` is a request (the switch, a shortcut, the host); `applied` and
   * `handler_refused` are what came of one; the rest happen by themselves.
   */
  private record(
    enabled: boolean,
    reason:
      | "initial"
      | "user"
      | "applied"
      | "handler_refused"
      | "device_lost"
      | "device_returned"
      | "no_device",
    more: Record<string, unknown> = {},
  ): void {
    if (this.diagSource === undefined) return;
    diag("mute", { source: this.diagSource, enabled, reason, ...more });
  }
}

export class MuteStates {
  /**
   *  True if the selected audio output device is an earpiece.
   *  Used to force-disable video when on earpiece.
   */
  private readonly isEarpiece$ = combineLatest([
    this.mediaDevices.audioOutput.available$,
    this.mediaDevices.audioOutput.selected$,
  ]).pipe(
    map(([available, selected]) => {
      if (!selected?.id) return false;
      const device = available.get(selected.id);
      logger.info(`MuteStates: selected audio output device:`, device);
      return device?.type === "earpiece";
    }),
  );

  public readonly audio = new MuteState(
    this.scope,
    this.mediaDevices.audioInput,
    this.initialMuteState.audioEnabled,
    constant(false),
    true,
    "microphone",
  );
  public readonly video = new MuteState(
    this.scope,
    this.mediaDevices.videoInput,
    this.initialMuteState.videoEnabled,
    this.isEarpiece$,
    false,
    "camera",
  );

  public constructor(
    private readonly scope: ObservableScope,
    private readonly mediaDevices: MediaDevices,
    private readonly initialMuteState: {
      audioEnabled: boolean;
      videoEnabled: boolean;
    },
    hostBridge: HostBridge,
  ) {
    // Keep the host informed of our mute state
    const muteState$ = combineLatest(
      [this.audio.enabled$, this.video.enabled$],
      (audio, video): DeviceMuteState => ({
        audio_enabled: audio,
        video_enabled: video,
      }),
    );
    muteState$.pipe(this.scope.bind()).subscribe((state) => {
      hostBridge
        .notifyDeviceMute(state)
        .catch((e) => logger.warn("Could not send mute state to the host", e));
    });

    // And apply the changes the host asks for
    hostBridge.deviceMute$
      .pipe(
        withLatestFrom(
          muteState$,
          this.audio.setEnabled$,
          this.video.setEnabled$,
        ),
        this.scope.bind(),
      )
      .subscribe(([request, state, setAudioEnabled, setVideoEnabled]) => {
        diag("mute_request", {
          reason: "host",
          audio: request.data.audio_enabled,
          video: request.data.video_enabled,
        });
        // First copy the current state into our new state
        const newState = { ...state };
        // Then apply whichever changes the host asked for
        if (
          typeof request.data.audio_enabled === "boolean" &&
          setAudioEnabled !== null
        ) {
          newState.audio_enabled = request.data.audio_enabled;
          setAudioEnabled(newState.audio_enabled);
        }
        if (
          typeof request.data.video_enabled === "boolean" &&
          setVideoEnabled !== null
        ) {
          newState.video_enabled = request.data.video_enabled;
          setVideoEnabled(newState.video_enabled);
        }
        request.reply(newState);
      });
  }
}
