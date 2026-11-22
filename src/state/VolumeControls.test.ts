/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BehaviorSubject } from "rxjs";

import { constant } from "./Behavior";
import { ObservableScope } from "./ObservableScope";
import {
  createVolumeControls,
  formatPlaybackVolume,
  playbackGain,
  playbackGainDb,
} from "./VolumeControls";
import { diagBuffer } from "../diagnostics/diag";
import { createCallActions } from "./callActions";

let scope: ObservableScope;
beforeEach(() => {
  localStorage.clear();
  scope = new ObservableScope();
});
afterEach(() => scope.end());

function controls(persistKey?: string): ReturnType<
  typeof createVolumeControls
> & {
  sink: ReturnType<typeof vi.fn>;
} {
  const sink = vi.fn();
  return {
    ...createVolumeControls(scope, {
      pretendToBeDisconnected$: constant(false),
      sink$: constant(sink),
      persistKey,
    }),
    sink,
  };
}

test("starts at full volume and passes changes to the sink", () => {
  const c = controls();
  expect(c.playbackVolume$.value).toBe(1);
  expect(c.sink).toHaveBeenLastCalledWith(1);
  c.adjustPlaybackVolume(1.5);
  // The sink is given the gain to play with: 150% is +6 dB
  expect(c.sink).toHaveBeenLastCalledWith(playbackGain(1.5));
  expect(c.sink.mock.lastCall![0]).toBeCloseTo(1.995, 3);
});

test("maps the slider to a gain in even steps for the ear", () => {
  // As it was sent at 100%, nothing at 0
  expect(playbackGain(1)).toBe(1);
  expect(playbackGain(0)).toBe(0);
  // 100% to 200% is 0 to +12 dB, linear in dB
  expect(playbackGainDb(1)).toBe(0);
  expect(playbackGainDb(1.25)).toBe(3);
  expect(playbackGainDb(1.5)).toBe(6);
  expect(playbackGainDb(1.8)).toBe(9.6);
  expect(playbackGainDb(2)).toBe(12);
  expect(playbackGain(1.5)).toBeCloseTo(1.995, 3);
  expect(playbackGain(2)).toBeCloseTo(3.981, 3);
  // Below 100% half way is about half as loud
  expect(playbackGain(0.5)).toBe(0.25);
  expect(playbackGainDb(0.5)).toBe(-12);
  expect(playbackGainDb(0)).toBeNull();
  // Never falling, without a step at 100%, and bounded
  let last = 0;
  for (let v = 0; v <= 2.0001; v += 0.01) {
    const gain = playbackGain(v);
    expect(gain).toBeGreaterThanOrEqual(last);
    expect(gain - last).toBeLessThan(0.06);
    last = gain;
  }
  expect(playbackGain(1.01) - playbackGain(0.99)).toBeLessThan(0.04);
  expect(playbackGain(7)).toBe(playbackGain(2));
  expect(playbackGain(-1)).toBe(0);
  expect(playbackGain(NaN)).toBe(0);
});

test("shows the dB beside the percentage above 100% only", () => {
  expect(formatPlaybackVolume(0)).toBe("0%");
  expect(formatPlaybackVolume(0.4)).toBe("40%");
  expect(formatPlaybackVolume(1)).toBe("100%");
  expect(formatPlaybackVolume(1.5)).toBe("150% · +6 dB");
  expect(formatPlaybackVolume(1.8)).toBe("180% · +9.6 dB");
  expect(formatPlaybackVolume(2)).toBe("200% · +12 dB");
});

test("writes a committed volume to the diagnostics with its gain in dB", () => {
  const c = controls("voice:@alice:example.org");
  c.adjustPlaybackVolume(1.75);
  c.commitPlaybackVolume();
  expect(diagBuffer().at(-1)).toMatchObject({
    type: "volume",
    of: "voice:@alice:example.org",
    volume: 1.75,
    gainDb: 9,
    limiter: true,
  });
  c.adjustPlaybackVolume(0.5);
  c.commitPlaybackVolume();
  expect(diagBuffer().at(-1)).toMatchObject({
    volume: 0.5,
    gain: 0.25,
    gainDb: -12,
    limiter: false,
  });
});

test("keeps a committed volume for the next call under the same key", () => {
  const first = controls("voice:@alice:example.org");
  first.adjustPlaybackVolume(0.4);
  first.commitPlaybackVolume();

  expect(controls("voice:@alice:example.org").playbackVolume$.value).toBe(0.4);
  // Her screen share and other members are not touched by it
  expect(controls("screen:@alice:example.org").playbackVolume$.value).toBe(1);
  expect(controls("voice:@bob:example.org").playbackVolume$.value).toBe(1);
});

test("keeps a mute, and what to return to when it is lifted", () => {
  const first = controls("screen:@alice:example.org");
  first.adjustPlaybackVolume(1.8);
  first.commitPlaybackVolume();
  first.togglePlaybackMuted();

  const second = controls("screen:@alice:example.org");
  expect(second.playbackMuted$.value).toBe(true);
  expect(second.sink).toHaveBeenLastCalledWith(0);
  second.togglePlaybackMuted();
  expect(second.playbackVolume$.value).toBe(1.8);
});

test("does not keep a drag that was never let go of, nor anything without a key", () => {
  const dragged = controls("voice:@alice:example.org");
  dragged.adjustPlaybackVolume(0.2);
  expect(controls("voice:@alice:example.org").playbackVolume$.value).toBe(1);

  const unkeyed = controls();
  unkeyed.adjustPlaybackVolume(0.2);
  unkeyed.commitPlaybackVolume();
  expect(localStorage.getItem("intercom-playback-volumes")).toBeNull();
});

test("ignores stored values that make no sense", () => {
  localStorage.setItem(
    "intercom-playback-volumes",
    JSON.stringify({ "voice:@alice:example.org": { volume: 50 } }),
  );
  expect(controls("voice:@alice:example.org").playbackVolume$.value).toBe(1);
  localStorage.setItem("intercom-playback-volumes", "not json");
  expect(controls("voice:@alice:example.org").playbackVolume$.value).toBe(1);
});

test("keeps an adjustment within what can be played", () => {
  const c = controls();
  c.adjustPlaybackVolume(1.29);
  expect(c.playbackVolume$.value).toBe(1.29);
  expect(c.sink).toHaveBeenLastCalledWith(playbackGain(1.29));
  c.adjustPlaybackVolume(7);
  expect(c.playbackVolume$.value).toBe(2);
  expect(c.sink).toHaveBeenLastCalledWith(playbackGain(2));
  c.adjustPlaybackVolume(-1);
  expect(c.sink).toHaveBeenLastCalledWith(0);
  c.adjustPlaybackVolume(1.4);
  c.adjustPlaybackVolume(NaN);
  expect(c.playbackVolume$.value).toBe(1.4);
  expect(c.sink).toHaveBeenLastCalledWith(playbackGain(1.4));
});

test("plays nothing while deafened, and what it played before once that ends", () => {
  const audio = {
    enabled$: new BehaviorSubject(true),
    setEnabled$: new BehaviorSubject<((enabled: boolean) => void) | null>(
      () => {},
    ),
  };
  const actions = createCallActions({
    audio,
    video: audio,
    playSound: () => {},
  });
  const c = controls();
  // Louder than 1, which is played through Web Audio rather than an element
  c.adjustPlaybackVolume(1.6);
  expect(c.sink).toHaveBeenLastCalledWith(playbackGain(1.6));

  actions.perform("toggle-deafen", "test");
  expect(c.sink).toHaveBeenLastCalledWith(0);
  // The slider keeps showing what the user set
  expect(c.playbackVolume$.value).toBe(1.6);

  actions.perform("toggle-deafen", "test");
  expect(c.sink).toHaveBeenLastCalledWith(playbackGain(1.6));
  actions.reset();
});
