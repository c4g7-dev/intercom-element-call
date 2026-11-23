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
  deafened: boolean;
  screen_sharing: boolean;
  /** Whether the connection to the call is being re-established */
  reconnecting: boolean;
  participants: HostParticipantState[];
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
  deafened$: Observable<boolean>;
  sharingScreen$: Observable<boolean>;
  reconnecting$: Observable<boolean>;
  participants$: Observable<HostParticipantState[]>;
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
  deafened$,
  sharingScreen$,
  reconnecting$,
  participants$,
}: HostCallStateInputs): Observable<HostCallState> {
  return combineLatest(
    [
      audioEnabled$,
      videoEnabled$,
      deafened$,
      sharingScreen$,
      reconnecting$,
      participants$,
    ],
    (
      audio_enabled,
      video_enabled,
      deafened,
      screen_sharing,
      reconnecting,
      participants,
    ): HostCallState => ({
      audio_enabled,
      video_enabled,
      deafened,
      screen_sharing,
      reconnecting,
      participants,
    }),
  ).pipe(
    debounceTime(HOST_CALL_STATE_DEBOUNCE_MS),
    distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  );
}
