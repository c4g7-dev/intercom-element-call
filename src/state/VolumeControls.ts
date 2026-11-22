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
import { deafened$ } from "./callActions";

/**
 * Controls for audio playback volume.
 */
export interface VolumeControls {
  /**
   * The volume to which the audio is set, as the position of the slider: 1 is
   * as it was sent, `MAX_PLAYBACK_VOLUME` the loudest. `playbackGain` is what
   * it is played with.
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
   * requested volume. It is given the gain to play with (`playbackGain`), not
   * the position of the slider.
   */
  sink$: Behavior<(volume: number) => void>;
  /**
   * Where the volume is kept between calls: one key per thing listened to
   * (a member's voice, a member's screen share). Not kept without one.
   */
  persistKey?: string;
}

/**
 * The top of the volume slider: 200%, which is `MAX_BOOST_DB` louder than the
 * track was sent.
 */
export const MAX_PLAYBACK_VOLUME = 2;

/** What the second half of the slider adds, in dB: 12 dB is four times the amplitude. */
export const MAX_BOOST_DB = 12;

/**
 * The gain a volume on the slider is played with, as an amplitude factor.
 * The slider is in steps the ear takes as even, which amplitude is not:
 *  - 100% to 200% is 0 to +12 dB, linear in dB (150% is +6 dB, twice the
 *    amplitude; 200% is four times). Twice the amplitude at 200%, as it was
 *    before, is only +6 dB and was barely heard as louder.
 *  - 0 to 100% is the square of the slider, so that half way is -12 dB,
 *    about half as loud, where the amplitude itself would give -6 dB and
 *    leave all of the change to the last tenth of the slider.
 */
export function playbackGain(volume: number): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  const v = Math.min(volume, MAX_PLAYBACK_VOLUME);
  return v <= 1 ? v * v : 10 ** (((v - 1) * MAX_BOOST_DB) / 20);
}

/** The same gain in dB; a muted volume has none. */
export function playbackGainDb(volume: number): number | null {
  const gain = playbackGain(volume);
  return gain === 0 ? null : Math.round(20 * Math.log10(gain) * 10) / 10;
}

/**
 * A volume as the sliders show it: the percentage, and above 100% what it
 * adds in dB ("180% · +9.6 dB").
 */
export function formatPlaybackVolume(volume: number): string {
  const percent = `${Math.round(volume * 100)}%`;
  const db = volume > 1 ? playbackGainDb(volume) : null;
  return db === null || db <= 0 ? percent : `${percent} · +${db} dB`;
}

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
      const volume = playbackVolume$.value;
      diag("volume", {
        of: persistKey,
        volume,
        gain: Math.round(playbackGain(volume) * 1000) / 1000,
        gainDb: playbackGainDb(volume),
        // Above 1 the track is played through a gain node and a limiter
        limiter: volume > 1,
      });
    });

  // Sync the requested volume with the audio playback module
  combineLatest([
    sink$,
    // The playback volume, taking into account whether we're supposed to
    // pretend that the audio stream is disconnected (since we don't necessarily
    // want that to modify the UI state).
    // Deafened is the same to the ear: nothing is played, whichever way a
    // track is played (one louder than 1 goes through Web Audio, which a
    // muted element does not silence).
    combineLatest([pretendToBeDisconnected$, deafened$]).pipe(
      switchMap(([disconnected, deafened]) =>
        disconnected || deafened ? of(0) : playbackVolume$,
      ),
    ),
  ])
    .pipe(scope.bind())
    .subscribe(([sink, volume]) => sink(playbackGain(volume)));

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
