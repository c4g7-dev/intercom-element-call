/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  map,
  type Observable,
  of,
  switchMap,
} from "rxjs";

import { type DeviceAvailability } from "./deviceAvailability";
import {
  type ALONE_TIMEOUT_LEFT_REASON,
  type AloneState,
  type HostAloneState,
  hostAloneState,
} from "./aloneTimer";

// Type aliases rather than interfaces, so that they satisfy the widget API's
// index-signature payload types.

/** One member of the call, as the host shows them in its list of the call. */
export type HostParticipantState = {
  user_id: string;
  /** Whether this is the user themselves */
  local: boolean;
  speaking: boolean;
  /** Whether their microphone is on */
  audio_enabled: boolean;
  /** Whether they are sharing a screen */
  screen_sharing: boolean;
};

/**
 * What the host is told about the call while the user is in it: enough to
 * show who is in it, who is talking, and the user's own microphone, camera,
 * deafening and screen share next to the host's own controls.
 */
export type HostCallState = {
  audio_enabled: boolean;
  video_enabled: boolean;
  /**
   * How the microphone and the camera stand: on, off, or not there to be
   * turned on ("no-device", "no-permission"). The host shows the same as the
   * call's own buttons from this.
   */
  audio_state: DeviceAvailability;
  video_state: DeviceAvailability;
  deafened: boolean;
  screen_sharing: boolean;
  /** Whether a screen can be shared here at all */
  can_share_screen: boolean;
  /** Whether the connection to the call is being re-established */
  reconnecting: boolean;
  participants: HostParticipantState[];
  /**
   * The countdown of a private call the user was left alone in: how long
   * until the call leaves by itself. Absent while none runs.
   */
  alone?: HostAloneState;
  /**
   * Why the call is about to leave by itself: sent once, right before it
   * does, so that the host can say why the call ended.
   */
  left_reason?: typeof ALONE_TIMEOUT_LEFT_REASON;
};

/** What of a member's media the state is read from. */
export interface HostStateMedia {
  userId: string;
  local: boolean;
  speaking$: Observable<boolean>;
  audioEnabled$: Observable<boolean>;
  screenShares$: Observable<unknown[]>;
}

/**
 * The members of the call for the host, one entry per user: somebody who is
 * in the call with two devices is speaking, unmuted or sharing if either is.
 */
export function hostParticipants$(
  media$: Observable<HostStateMedia[]>,
): Observable<HostParticipantState[]> {
  return media$.pipe(
    switchMap((media) =>
      media.length === 0
        ? of([])
        : combineLatest(
            media.map((m) =>
              combineLatest(
                [m.speaking$, m.audioEnabled$, m.screenShares$],
                (speaking, audioEnabled, screenShares) => ({
                  user_id: m.userId,
                  local: m.local,
                  speaking,
                  audio_enabled: audioEnabled,
                  screen_sharing: screenShares.length > 0,
                }),
              ),
            ),
          ),
    ),
    map(mergeByUser),
  );
}

function mergeByUser(states: HostParticipantState[]): HostParticipantState[] {
  const byUser = new Map<string, HostParticipantState>();
  for (const state of states) {
    const before = byUser.get(state.user_id);
    byUser.set(
      state.user_id,
      before === undefined
        ? state
        : {
            user_id: state.user_id,
            local: before.local || state.local,
            speaking: before.speaking || state.speaking,
            audio_enabled: before.audio_enabled || state.audio_enabled,
            screen_sharing: before.screen_sharing || state.screen_sharing,
          },
    );
  }
  return [...byUser.values()];
}

interface HostCallStateInputs {
  audioEnabled$: Observable<boolean>;
  videoEnabled$: Observable<boolean>;
  audioState$: Observable<DeviceAvailability>;
  videoState$: Observable<DeviceAvailability>;
  deafened$: Observable<boolean>;
  sharingScreen$: Observable<boolean>;
  canShareScreen: boolean;
  reconnecting$: Observable<boolean>;
  participants$: Observable<HostParticipantState[]>;
  /** Whether the user is alone in a private call, and until when they stay */
  alone$?: Observable<AloneState | undefined>;
  /** The time, in ms: what is left of a countdown is told from it */
  now?: () => number;
}

/** How long the state must hold still before the host is told: speaking flickers. */
export const HOST_CALL_STATE_DEBOUNCE_MS = 120;

/**
 * The state of the call for the host: emitted when something in it changed,
 * and not more often than every {@link HOST_CALL_STATE_DEBOUNCE_MS}.
 */
export function hostCallState$({
  audioEnabled$,
  videoEnabled$,
  audioState$,
  videoState$,
  deafened$,
  sharingScreen$,
  canShareScreen,
  reconnecting$,
  participants$,
  alone$ = of(undefined),
  now = (): number => Date.now(),
}: HostCallStateInputs): Observable<HostCallState> {
  return combineLatest(
    [
      audioEnabled$,
      videoEnabled$,
      audioState$,
      videoState$,
      deafened$,
      sharingScreen$,
      reconnecting$,
      participants$,
      alone$,
    ],
    (
      audio_enabled,
      video_enabled,
      audio_state,
      video_state,
      deafened,
      screen_sharing,
      reconnecting,
      participants,
      aloneState,
    ): HostCallState => {
      // What is left at this moment: the host counts down from there
      const alone = hostAloneState(aloneState, now());
      return {
        audio_enabled,
        video_enabled,
        audio_state,
        video_state,
        deafened,
        screen_sharing,
        can_share_screen: canShareScreen,
        reconnecting,
        participants,
        ...(alone !== undefined && { alone }),
      };
    },
  ).pipe(
    debounceTime(HOST_CALL_STATE_DEBOUNCE_MS),
    distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  );
}
