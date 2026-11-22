/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BehaviorSubject } from "rxjs";

import { constant } from "./Behavior";
import { ObservableScope } from "./ObservableScope";
import { createVolumeControls } from "./VolumeControls";
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
  c.adjustPlaybackVolume(1.5);
  expect(c.sink).toHaveBeenLastCalledWith(1.5);
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
  expect(c.sink).toHaveBeenLastCalledWith(1.29);
  c.adjustPlaybackVolume(7);
  expect(c.sink).toHaveBeenLastCalledWith(2);
  c.adjustPlaybackVolume(-1);
  expect(c.sink).toHaveBeenLastCalledWith(0);
  c.adjustPlaybackVolume(1.4);
  c.adjustPlaybackVolume(NaN);
  expect(c.sink).toHaveBeenLastCalledWith(1.4);
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
  expect(c.sink).toHaveBeenLastCalledWith(1.6);

  actions.perform("toggle-deafen", "test");
  expect(c.sink).toHaveBeenLastCalledWith(0);
  // The slider keeps showing what the user set
  expect(c.playbackVolume$.value).toBe(1.6);

  actions.perform("toggle-deafen", "test");
  expect(c.sink).toHaveBeenLastCalledWith(1.6);
  actions.reset();
});
