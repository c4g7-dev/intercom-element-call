/*
Copyright 2026 Element Software Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { combineLatest, map, merge, of, Subject, switchMap, tap } from "rxjs";

import { type Behavior } from "./Behavior";
import { type ObservableScope } from "./ObservableScope";
import { accumulate } from "../utils/observable";
import { diag } from "../diagnostics/diag";

/**
 * Controls for audio playback volume.
 */
export interface VolumeControls {
  /**
   * The volume to which the audio is set, as a scalar multiplier.
   */
  playbackVolume$: Behavior<number>;
  /**
   * Whether playback of this audio is disabled.
   */
  playbackMuted$: Behavior<boolean>;
  togglePlaybackMuted: () => void;
  adjustPlaybackVolume: (value: number) => void;
  commitPlaybackVolume: () => void;
}

interface VolumeControlsInputs {
  pretendToBeDisconnected$: Behavior<boolean>;
  /**
   * The callback to run to notify the module performing audio playback of the
   * requested volume.
   */
  sink$: Behavior<(volume: number) => void>;
  /**
   * Where the volume is kept between calls: one key per thing listened to
   * (a member's voice, a member's screen share). Not kept without one.
   */
  persistKey?: string;
}

/** The loudest a track can be played: twice as loud as it was sent. */
export const MAX_PLAYBACK_VOLUME = 2;

const STORAGE_KEY = "intercom-playback-volumes";

interface StoredVolume {
  volume: number;
  committedVolume: number;
}

function readStoredVolumes(): Record<string, StoredVolume> {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    return typeof stored === "object" && stored !== null
      ? (stored as Record<string, StoredVolume>)
      : {};
  } catch {
    return {};
  }
}

function storedVolume(key: string | undefined): StoredVolume {
  const stored = key === undefined ? undefined : readStoredVolumes()[key];
  const valid = (v: unknown): v is number =>
    typeof v === "number" && v >= 0 && v <= MAX_PLAYBACK_VOLUME;
  return stored && valid(stored.volume) && valid(stored.committedVolume)
    ? { volume: stored.volume, committedVolume: stored.committedVolume || 1 }
    : { volume: 1, committedVolume: 1 };
}

function storeVolume(key: string, state: StoredVolume): void {
  try {
    const all = readStoredVolumes();
    // The default is not worth an entry
    if (state.volume === 1 && state.committedVolume === 1) delete all[key];
    else all[key] = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage that is full or forbidden only costs the memory
  }
}

/**
 * Creates a set of controls for audio playback volume and syncs this with the
 * audio playback module for the duration of the scope.
 */
export function createVolumeControls(
  scope: ObservableScope,
  { pretendToBeDisconnected$, sink$, persistKey }: VolumeControlsInputs,
): VolumeControls {
  const initial = storedVolume(persistKey);
  let pendingStore: StoredVolume | undefined;
  const toggleMuted$ = new Subject<"toggle mute">();
  const adjustVolume$ = new Subject<number>();
  const commitVolume$ = new Subject<"commit">();

  const playbackVolume$ = scope.behavior<number>(
    merge(toggleMuted$, adjustVolume$, commitVolume$).pipe(
      accumulate(initial, (state, event) => {
        switch (event) {
          case "toggle mute":
            return {
              ...state,
              volume: state.volume === 0 ? state.committedVolume : 0,
            };
          case "commit":
            // Dragging the slider to zero should have the same effect as
            // muting: keep the original committed volume, as if it were never
            // dragged
            return {
              ...state,
              committedVolume:
                state.volume === 0 ? state.committedVolume : state.volume,
            };
          default:
            // Volume adjustment, kept within what can be played
            return {
              ...state,
              volume: Number.isFinite(event)
                ? Math.min(Math.max(event, 0), MAX_PLAYBACK_VOLUME)
                : state.volume,
            };
        }
      }),
      // Kept once the user lets go, not for every step of a drag
      tap({
        next: (state) => {
          if (persistKey !== undefined && state !== initial)
            pendingStore = state;
        },
      }),
      map(({ volume }) => volume),
    ),
  );
  merge(toggleMuted$, commitVolume$)
    .pipe(scope.bind())
    .subscribe(() => {
      if (persistKey !== undefined && pendingStore !== undefined)
        storeVolume(persistKey, pendingStore);
      diag("volume", { of: persistKey, volume: playbackVolume$.value });
    });

  // Sync the requested volume with the audio playback module
  combineLatest([
    sink$,
    // The playback volume, taking into account whether we're supposed to
    // pretend that the audio stream is disconnected (since we don't necessarily
    // want that to modify the UI state).
    pretendToBeDisconnected$.pipe(
      switchMap((disconnected) => (disconnected ? of(0) : playbackVolume$)),
    ),
  ])
    .pipe(scope.bind())
    .subscribe(([sink, volume]) => sink(volume));

  return {
    playbackVolume$,
    playbackMuted$: scope.behavior<boolean>(
      playbackVolume$.pipe(map((volume) => volume === 0)),
    ),
    togglePlaybackMuted: () => toggleMuted$.next("toggle mute"),
    adjustPlaybackVolume: (value: number) => adjustVolume$.next(value),
    commitPlaybackVolume: () => commitVolume$.next("commit"),
  };
}
