/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BehaviorSubject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  callActionForKey,
  createCallActions,
  deafened$,
  isCallAction,
} from "./callActions";
import { diagBuffer, diagOutput, resetDiag } from "../diagnostics/diag";

function device(
  enabled: boolean,
  controllable = true,
): {
  enabled$: BehaviorSubject<boolean>;
  setEnabled$: BehaviorSubject<((enabled: boolean) => void) | null>;
} {
  const enabled$ = new BehaviorSubject(enabled);
  return {
    enabled$,
    setEnabled$: new BehaviorSubject<((enabled: boolean) => void) | null>(
      controllable ? (value: boolean): void => enabled$.next(value) : null,
    ),
  };
}

function setUp(
  mic = true,
  camera = false,
): {
  actions: ReturnType<typeof createCallActions>;
  audio: ReturnType<typeof device>;
  video: ReturnType<typeof device>;
  playSound: ReturnType<typeof vi.fn<(on: boolean) => void>>;
} {
  const audio = device(mic);
  const video = device(camera);
  const playSound = vi.fn<(on: boolean) => void>();
  return {
    actions: createCallActions({ audio, video, playSound }),
    audio,
    video,
    playSound,
  };
}

const writeDiag = diagOutput.write;
let current: ReturnType<typeof setUp> | undefined;
beforeEach(() => {
  diagOutput.write = (): void => {};
  resetDiag();
});
afterEach(() => {
  diagOutput.write = writeDiag;
  current?.actions.reset();
  current = undefined;
});
const start = (...args: Parameters<typeof setUp>): ReturnType<typeof setUp> =>
  (current = setUp(...args));

describe("callActionForKey", () => {
  const key = (
    key: string,
    modifiers: Partial<
      Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>
    > = { ctrlKey: true, shiftKey: true },
  ): Parameters<typeof callActionForKey>[0] => ({
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers,
  });

  it("knows Ctrl+Shift+M, D and V, whatever the case", () => {
    expect(callActionForKey(key("M"))).toBe("toggle-mute");
    expect(callActionForKey(key("m"))).toBe("toggle-mute");
    expect(callActionForKey(key("D"))).toBe("toggle-deafen");
    expect(callActionForKey(key("V"))).toBe("toggle-camera");
  });

  it("leaves every other key and combination alone", () => {
    expect(callActionForKey(key("x"))).toBeUndefined();
    expect(callActionForKey(key("m", {}))).toBeUndefined();
    expect(callActionForKey(key("m", { ctrlKey: true }))).toBeUndefined();
    expect(callActionForKey(key("m", { shiftKey: true }))).toBeUndefined();
    expect(
      callActionForKey(key("d", { ctrlKey: true, altKey: true })),
    ).toBeUndefined();
    expect(
      callActionForKey(
        key("d", { ctrlKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBeUndefined();
    expect(
      callActionForKey(
        key("m", { ctrlKey: true, shiftKey: true, metaKey: true }),
      ),
    ).toBeUndefined();
  });
});

describe("isCallAction", () => {
  it("accepts the actions and nothing else", () => {
    for (const action of [
      "toggle-mute",
      "mute",
      "unmute",
      "toggle-camera",
      "toggle-deafen",
    ])
      expect(isCallAction(action)).toBe(true);
    for (const other of [
      "leave-call",
      "",
      "TOGGLE-MUTE",
      5,
      null,
      undefined,
      {},
    ])
      expect(isCallAction(other)).toBe(false);
  });
});

describe("createCallActions", () => {
  it("toggles, mutes and unmutes the microphone, with a sound for each change", () => {
    const { actions, audio, playSound } = start(true);
    expect(actions.perform("toggle-mute", "test").audio_enabled).toBe(false);
    expect(audio.enabled$.value).toBe(false);
    expect(playSound).toHaveBeenLastCalledWith(false);
    actions.perform("toggle-mute", "test");
    expect(audio.enabled$.value).toBe(true);
    expect(playSound).toHaveBeenLastCalledWith(true);

    actions.perform("mute", "test");
    actions.perform("mute", "test");
    expect(audio.enabled$.value).toBe(false);
    actions.perform("unmute", "test");
    actions.perform("unmute", "test");
    expect(audio.enabled$.value).toBe(true);
    // Asking for what is already so changes nothing and makes no sound
    expect(playSound).toHaveBeenCalledTimes(4);
  });

  it("toggles the camera, silently", () => {
    const { actions, video, playSound } = start(true, false);
    expect(actions.perform("toggle-camera", "test").video_enabled).toBe(true);
    expect(video.enabled$.value).toBe(true);
    actions.perform("toggle-camera", "test");
    expect(video.enabled$.value).toBe(false);
    expect(playSound).not.toHaveBeenCalled();
  });

  it("deafens: mutes the microphone too, and puts it back as it was", () => {
    const { actions, audio, playSound } = start(true);
    expect(actions.perform("toggle-deafen", "test")).toEqual({
      audio_enabled: false,
      video_enabled: false,
      deafened: true,
    });
    expect(deafened$.value).toBe(true);
    expect(playSound).toHaveBeenLastCalledWith(false);

    expect(actions.perform("toggle-deafen", "test")).toMatchObject({
      audio_enabled: true,
      deafened: false,
    });
    expect(audio.enabled$.value).toBe(true);
    expect(playSound).toHaveBeenLastCalledWith(true);
  });

  it("leaves a microphone off that was off before the deafening", () => {
    const { actions, audio } = start(false);
    actions.perform("toggle-deafen", "test");
    actions.perform("toggle-deafen", "test");
    expect(audio.enabled$.value).toBe(false);
    expect(deafened$.value).toBe(false);
  });

  it("ends the deafening when the microphone is unmuted", () => {
    const { actions, audio } = start(true);
    actions.perform("toggle-deafen", "test");
    expect(actions.perform("toggle-mute", "test")).toMatchObject({
      audio_enabled: true,
      deafened: false,
    });
    actions.perform("toggle-deafen", "test");
    actions.perform("unmute", "test");
    expect(deafened$.value).toBe(false);
    expect(audio.enabled$.value).toBe(true);
  });

  it("stays deafened and muted when muted while deafened", () => {
    const { actions, audio } = start(true);
    actions.perform("toggle-deafen", "test");
    actions.perform("mute", "test");
    expect(deafened$.value).toBe(true);
    actions.perform("toggle-deafen", "test");
    expect(audio.enabled$.value).toBe(false);
  });

  it("does what it can where a device cannot be controlled", () => {
    const audio = device(false, false);
    const video = device(false, false);
    const playSound = vi.fn();
    const actions = createCallActions({ audio, video, playSound });
    current = { actions, audio, video, playSound };
    expect(actions.perform("toggle-mute", "test").audio_enabled).toBe(false);
    expect(actions.perform("toggle-camera", "test").video_enabled).toBe(false);
    expect(actions.perform("toggle-deafen", "test").deafened).toBe(true);
  });

  it("ends a deafening with the call", () => {
    const { actions } = start(true);
    actions.perform("toggle-deafen", "test");
    actions.reset();
    expect(deafened$.value).toBe(false);
  });

  it("records every action and where it came from", () => {
    const { actions } = start(true);
    actions.perform("toggle-deafen", "host");
    actions.perform("toggle-mute", "keyboard");
    expect(
      diagBuffer()
        .filter((r) => r.type === "call_action")
        .map((r) => [r.action, r.source, r.deafened]),
    ).toEqual([
      ["toggle-deafen", "host", true],
      ["toggle-mute", "keyboard", false],
    ]);
  });
});
