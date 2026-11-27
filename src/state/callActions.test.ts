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
  parseHostVoiceState,
} from "./callActions";
import { constant } from "./Behavior";
import { diagBuffer, diagOutput, resetDiag } from "../diagnostics/diag";
import { detailedReadings$ } from "../diagnostics/CallDiagnostics";
import { diagnosticsOverlay } from "../settings/settings";

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
    expect(callActionForKey(key("S"))).toBe("toggle-screenshare");
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
      "toggle-screenshare",
      "screenshare-settings",
      "toggle-diagnostics",
      "connection-details-on",
      "connection-details-off",
      "stay-in-call",
      "alone-timeout",
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

describe("the host's mute and deafen", () => {
  const voice = (
    muted: boolean,
    deafened = false,
    before = false,
  ): { muted: boolean; deafened: boolean; muted_before_deafen: boolean } => ({
    muted,
    deafened,
    muted_before_deafen: before,
  });

  it("reads what the host sends and nothing else", () => {
    expect(parseHostVoiceState(voice(true))).toEqual(voice(true));
    // Deafened is muted
    expect(parseHostVoiceState({ muted: false, deafened: true })).toEqual(
      voice(true, true),
    );
    for (const other of [undefined, null, {}, { muted: "yes" }, "muted", 1])
      expect(parseHostVoiceState(other)).toBeUndefined();
  });

  it("joins muted where the host says so, silently", () => {
    const { actions, audio, playSound } = start(true);
    expect(actions.applyVoiceState(voice(true), "host-join")).toMatchObject({
      audio_enabled: false,
      deafened: false,
    });
    expect(audio.enabled$.value).toBe(false);
    expect(playSound).not.toHaveBeenCalled();
  });

  it("joins deafened where the host says so, and undeafens as the host has it", () => {
    const { actions, audio } = start(true);
    actions.applyVoiceState(voice(true, true, false), "host-join");
    expect(deafened$.value).toBe(true);
    expect(audio.enabled$.value).toBe(false);
    // Undeafened by the call's own shortcut: the microphone was on before
    actions.perform("toggle-deafen", "keyboard");
    expect(deafened$.value).toBe(false);
    expect(audio.enabled$.value).toBe(true);

    actions.applyVoiceState(voice(true, true, true), "host");
    actions.perform("toggle-deafen", "keyboard");
    expect(deafened$.value).toBe(false);
    expect(audio.enabled$.value).toBe(false);
  });

  it("leaves a microphone that is on alone where the host says unmuted", () => {
    const { actions, audio } = start(true);
    const set = vi.fn();
    audio.setEnabled$.next(set);
    actions.applyVoiceState(voice(false), "host-join");
    expect(set).not.toHaveBeenCalled();
    expect(deafened$.value).toBe(false);
  });

  it("mutes as soon as the microphone can be controlled", () => {
    const audio = {
      enabled$: new BehaviorSubject(true),
      setEnabled$: new BehaviorSubject<((enabled: boolean) => void) | null>(
        null,
      ),
    };
    const video = {
      enabled$: new BehaviorSubject(false),
      setEnabled$: new BehaviorSubject<((enabled: boolean) => void) | null>(
        null,
      ),
    };
    const actions = createCallActions({ audio, video, playSound: vi.fn() });
    try {
      actions.applyVoiceState(voice(true), "host-join");
      expect(audio.enabled$.value).toBe(true);
      audio.setEnabled$.next((value) => audio.enabled$.next(value));
      expect(audio.enabled$.value).toBe(false);
      // Only once: what the user does afterwards stands
      audio.enabled$.next(true);
      audio.setEnabled$.next((value) => audio.enabled$.next(value));
      expect(audio.enabled$.value).toBe(true);
    } finally {
      actions.reset();
    }
  });

  it("a later state from the host replaces one that was still waiting", () => {
    const audio = {
      enabled$: new BehaviorSubject(true),
      setEnabled$: new BehaviorSubject<((enabled: boolean) => void) | null>(
        null,
      ),
    };
    const video = {
      enabled$: new BehaviorSubject(false),
      setEnabled$: new BehaviorSubject<((enabled: boolean) => void) | null>(
        null,
      ),
    };
    const actions = createCallActions({ audio, video, playSound: vi.fn() });
    try {
      actions.applyVoiceState(voice(true), "host-join");
      actions.applyVoiceState(voice(false), "host");
      audio.setEnabled$.next((value) => audio.enabled$.next(value));
      expect(audio.enabled$.value).toBe(true);
    } finally {
      actions.reset();
    }
  });

  it("leaves the cues to the host once the host keeps the state", () => {
    const { actions, playSound } = start(true);
    actions.applyVoiceState(voice(false), "host-join");
    actions.perform("toggle-mute", "keyboard");
    actions.perform("toggle-deafen", "keyboard");
    actions.perform("toggle-deafen", "keyboard");
    expect(playSound).not.toHaveBeenCalled();
  });

  it("ends a deafening when the microphone is turned on by other means", () => {
    const { actions, audio } = start(true);
    actions.perform("toggle-deafen", "keyboard");
    expect(deafened$.value).toBe(true);
    // The call's own microphone button
    audio.setEnabled$.value?.(true);
    expect(deafened$.value).toBe(false);
    expect(actions.state()).toMatchObject({
      audio_enabled: true,
      deafened: false,
    });
  });
});

describe("the screen share actions", () => {
  it("press the share button and open its settings, as the call wired them", () => {
    const toggle = vi.fn();
    const openShareSettings = vi.fn();
    const off = { enabled$: constant(false), setEnabled$: constant(null) };
    const actions = createCallActions({
      audio: off,
      video: off,
      playSound: vi.fn(),
      toggleScreenShare: () => toggle,
      openShareSettings,
    });
    actions.perform("toggle-screenshare", "test");
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(openShareSettings).not.toHaveBeenCalled();
    actions.perform("screenshare-settings", "test");
    expect(openShareSettings).toHaveBeenCalledTimes(1);
    actions.reset();
  });

  it("do nothing where the call cannot share", () => {
    const off = { enabled$: constant(false), setEnabled$: constant(null) };
    const actions = createCallActions({
      audio: off,
      video: off,
      toggleScreenShare: () => null,
    });
    expect(() => actions.perform("toggle-screenshare", "test")).not.toThrow();
    expect(() => actions.perform("screenshare-settings", "test")).not.toThrow();
    actions.reset();
  });
});

describe("the diagnostics actions", () => {
  const off = { enabled$: constant(false), setEnabled$: constant(null) };

  it("toggle the overlay, and take whether the host shows the connection's details", () => {
    resetDiag();
    const toggleDiagnostics = vi.fn();
    const setConnectionDetails = vi.fn();
    const actions = createCallActions({
      audio: off,
      video: off,
      toggleDiagnostics,
      setConnectionDetails,
    });
    actions.perform("toggle-diagnostics", "host");
    expect(toggleDiagnostics).toHaveBeenCalledTimes(1);
    expect(setConnectionDetails).not.toHaveBeenCalled();

    expect(actions.perform("connection-details-on", "host")).toEqual(
      actions.state(),
    );
    expect(setConnectionDetails).toHaveBeenLastCalledWith(true);
    actions.perform("connection-details-off", "host");
    expect(setConnectionDetails).toHaveBeenLastCalledWith(false);
    // A popover opening is not a thing to write down; the overlay is
    expect(
      diagBuffer()
        .filter((r) => r.type === "call_action")
        .map((r) => r.action),
    ).toEqual(["toggle-diagnostics"]);

    // The call ends: nobody watches a call that is not there
    setConnectionDetails.mockClear();
    actions.reset();
    expect(setConnectionDetails).toHaveBeenCalledWith(false);
  });

  it("stay in a call the user is alone in, and take another timeout for it", () => {
    const stayInCall = vi.fn();
    const setAloneTimeout = vi.fn();
    const actions = createCallActions({
      audio: off,
      video: off,
      stayInCall,
      setAloneTimeout,
    });
    expect(actions.perform("stay-in-call", "host")).toEqual(actions.state());
    expect(stayInCall).toHaveBeenCalledTimes(1);
    expect(setAloneTimeout).not.toHaveBeenCalled();

    actions.perform("alone-timeout", "host", {
      action: "alone-timeout",
      timeout: 180,
    });
    expect(setAloneTimeout).toHaveBeenLastCalledWith(180);
    actions.perform("alone-timeout", "host", { timeout: "never" });
    expect(setAloneTimeout).toHaveBeenLastCalledWith("never");
    // Nothing came with it: for whoever takes it to make sense of
    actions.perform("alone-timeout", "host");
    expect(setAloneTimeout).toHaveBeenLastCalledWith(undefined);
    expect(stayInCall).toHaveBeenCalledTimes(1);

    // A call that has no countdown does nothing about either
    const plain = createCallActions({ audio: off, video: off });
    expect(plain.perform("stay-in-call", "host")).toEqual(plain.state());
    expect(plain.perform("alone-timeout", "host")).toEqual(plain.state());
  });

  it("are the overlay's setting and the pace of the readings where nothing else is given", () => {
    const actions = createCallActions({ audio: off, video: off });
    const before = diagnosticsOverlay.getValue();
    actions.perform("toggle-diagnostics", "host");
    expect(diagnosticsOverlay.getValue()).toBe(!before);
    actions.perform("toggle-diagnostics", "host");
    expect(diagnosticsOverlay.getValue()).toBe(before);

    actions.perform("connection-details-on", "host");
    expect(detailedReadings$.value).toBe(true);
    actions.reset();
    expect(detailedReadings$.value).toBe(false);
  });
});
