/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BehaviorSubject } from "rxjs";

import { type Behavior } from "./Behavior";
import { diag } from "../diagnostics/diag";
import { soundEffectVolume } from "../settings/settings";

/**
 * What a shortcut or the host can ask of the call: the microphone, the
 * camera, and deafening, which is hearing nobody and being heard by nobody.
 */
export type CallAction =
  | "toggle-mute"
  | "mute"
  | "unmute"
  | "toggle-camera"
  | "toggle-deafen";

const callActions = new Set<string>([
  "toggle-mute",
  "mute",
  "unmute",
  "toggle-camera",
  "toggle-deafen",
]);

export function isCallAction(value: unknown): value is CallAction {
  return typeof value === "string" && callActions.has(value);
}

/** The state the host is told after an action. */
export type CallActionState = {
  audio_enabled: boolean;
  video_enabled: boolean;
  deafened: boolean;
};

const deafenedSubject$ = new BehaviorSubject(false);
/** Whether the user is deafened: every incoming sound of the call is muted. */
export const deafened$: Behavior<boolean> = deafenedSubject$;

/** The shortcut a key press is, if it is one: Ctrl+Shift+M, D or V. */
export function callActionForKey(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
  >,
): CallAction | undefined {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey)
    return undefined;
  switch (event.key.toLowerCase()) {
    case "m":
      return "toggle-mute";
    case "d":
      return "toggle-deafen";
    case "v":
      return "toggle-camera";
    default:
      return undefined;
  }
}

interface Device {
  enabled$: Behavior<boolean>;
  setEnabled$: Behavior<((enabled: boolean) => void) | null>;
}

interface CallActionInputs {
  audio: Device;
  video: Device;
  /** Plays the sound of the microphone or the hearing going on or off. */
  playSound?: (on: boolean) => void;
}

let toneContext: AudioContext | undefined;
/**
 * Two short tones, rising for on and falling for off, at the volume of the
 * call's other sound effects (and none where that is turned down to zero).
 */
export function playToggleSound(on: boolean): void {
  try {
    const volume = soundEffectVolume.getValue();
    if (!(volume > 0) || typeof AudioContext === "undefined") return;
    if (toneContext === undefined || toneContext.state === "closed")
      toneContext = new AudioContext();
    const context = toneContext;
    if (context.state === "suspended") context.resume().catch(() => undefined);
    const [first, second] = on ? [520, 780] : [780, 520];
    const start = context.currentTime + 0.01;
    for (const [i, frequency] of [first, second].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = start + i * 0.09;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.25 * volume, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.085);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.09);
    }
  } catch {
    // A sound that cannot be played is not worth more than that
  }
}

/**
 * Carries out the call actions against the microphone and the camera, and
 * keeps the deafened state. Deafening mutes the microphone too and
 * remembers whether it was on, to put it back; unmuting ends a deafening,
 * since nobody wants to talk to people they cannot hear.
 */
export function createCallActions({
  audio,
  video,
  playSound = playToggleSound,
}: CallActionInputs): {
  perform: (action: CallAction, source: string) => CallActionState;
  /** How things are, with nothing done. */
  state: () => CallActionState;
  /** Ends a deafening with the call it was for. */
  reset: () => void;
} {
  let micBeforeDeafen = false;
  const state = (): CallActionState => ({
    audio_enabled: audio.enabled$.value,
    video_enabled: video.enabled$.value,
    deafened: deafenedSubject$.value,
  });
  const setMic = (enabled: boolean): boolean => {
    const set = audio.setEnabled$.value;
    if (set === null || audio.enabled$.value === enabled) return false;
    set(enabled);
    return true;
  };

  const perform = (action: CallAction, source: string): CallActionState => {
    const before = state();
    switch (action) {
      case "toggle-camera":
        video.setEnabled$.value?.(!video.enabled$.value);
        break;
      case "toggle-deafen":
        if (deafenedSubject$.value) {
          deafenedSubject$.next(false);
          if (micBeforeDeafen) setMic(true);
          playSound(true);
        } else {
          micBeforeDeafen = audio.enabled$.value;
          deafenedSubject$.next(true);
          setMic(false);
          playSound(false);
        }
        break;
      case "mute":
      case "unmute":
      case "toggle-mute": {
        const enable =
          action === "toggle-mute"
            ? !audio.enabled$.value
            : action === "unmute";
        const wasDeafened = deafenedSubject$.value;
        if (enable && wasDeafened) deafenedSubject$.next(false);
        // Muted by hand while deafened: stay muted when the deafening ends
        if (!enable && wasDeafened) micBeforeDeafen = false;
        if (setMic(enable) || (enable && wasDeafened)) playSound(enable);
        break;
      }
    }
    // What was asked for, which the devices follow in their own time
    const after: CallActionState = {
      ...state(),
      ...(action === "toggle-camera" &&
        video.setEnabled$.value !== null && {
          video_enabled: !before.video_enabled,
        }),
    };
    diag("call_action", { action, source, deafened: after.deafened });
    return after;
  };

  return {
    perform,
    state,
    reset: (): void => {
      if (deafenedSubject$.value) deafenedSubject$.next(false);
      micBeforeDeafen = false;
    },
  };
}
