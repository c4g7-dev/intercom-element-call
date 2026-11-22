/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BehaviorSubject } from "rxjs";

import {
  closeAllPopouts,
  openPopout,
  poppedOutIds$,
  popoutWindowName,
} from "./popout";
import { mockVideoTrack } from "../utils/test";

const labels = { fullscreen: "Fullscreen", mute: "Mute", volume: "Volume" };

/** A window as `window.open` returns it: a document of its own that can be closed. */
function fakeWindow(): Window {
  const doc = document.implementation.createHTMLDocument("");
  const win = {
    document: doc,
    closed: false,
    focus: vi.fn(),
    close: vi.fn(() => (win.closed = true)),
    addEventListener: vi.fn(),
  };
  return win as unknown as Window;
}

class FakeMediaStream {
  public constructor(public readonly tracks: MediaStreamTrack[]) {}
}

function fakeTrack(): MediaStreamTrack {
  return {
    readyState: "live",
    addEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

let open: ReturnType<typeof vi.fn>;
let opened: Window[];

beforeEach(() => {
  vi.useFakeTimers();
  opened = [];
  open = vi.fn(() => {
    const win = fakeWindow();
    opened.push(win);
    return win;
  });
  vi.stubGlobal("open", open);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  HTMLMediaElement.prototype.play = vi.fn(async () => Promise.resolve());
});

afterEach(() => {
  closeAllPopouts();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("openPopout", () => {
  test("opens a named popup and shows the track in it", () => {
    const track = fakeTrack();
    const release = vi.fn();
    const video = mockVideoTrack({
      source: "screenShare",
      mediaStreamTrack$: new BehaviorSubject<MediaStreamTrack | undefined>(
        track,
      ),
      requestHighQuality: vi.fn(() => release),
    });

    expect(
      openPopout({
        id: "@alice:example.org:screenShare",
        title: "Alice – screen",
        video,
        labels,
      }),
    ).toBe(true);

    // The name is the contract with the host, which lets only these open
    expect(open).toHaveBeenCalledWith(
      "",
      "intercom-popout-_alice_example_org_screenShare",
      "popup,width=1280,height=720",
    );
    const doc = opened[0].document;
    expect(doc.title).toBe("Alice – screen");
    const element = doc.querySelector("video")!;
    expect(element.muted).toBe(true);
    expect((element.srcObject as unknown as FakeMediaStream).tracks).toEqual([
      track,
    ]);
    expect(video.requestHighQuality).toHaveBeenCalledOnce();
    expect(poppedOutIds$.value.has("@alice:example.org:screenShare")).toBe(
      true,
    );

    closeAllPopouts();
    expect(opened[0].close).toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(poppedOutIds$.value.size).toBe(0);
  });

  test("focuses the window that is already there", () => {
    const video = mockVideoTrack({
      mediaStreamTrack$: new BehaviorSubject<MediaStreamTrack | undefined>(
        fakeTrack(),
      ),
    });
    openPopout({ id: "a", title: "A", video, labels });
    openPopout({ id: "a", title: "A", video, labels });
    expect(open).toHaveBeenCalledOnce();
    expect(opened[0].focus).toHaveBeenCalledOnce();
  });

  test("closes once the track has been gone for good, not for a moment", () => {
    const track$ = new BehaviorSubject<MediaStreamTrack | undefined>(
      fakeTrack(),
    );
    const video = mockVideoTrack({ mediaStreamTrack$: track$ });
    openPopout({ id: "a", title: "A", video, labels });

    // A resubscription: the track comes back in time
    track$.next(undefined);
    vi.advanceTimersByTime(2000);
    track$.next(fakeTrack());
    vi.advanceTimersByTime(10_000);
    expect(opened[0].close).not.toHaveBeenCalled();

    track$.next(undefined);
    vi.advanceTimersByTime(5000);
    expect(opened[0].close).toHaveBeenCalled();
  });

  test("forgets a window the user closed", () => {
    const video = mockVideoTrack({
      mediaStreamTrack$: new BehaviorSubject<MediaStreamTrack | undefined>(
        fakeTrack(),
      ),
    });
    openPopout({ id: "a", title: "A", video, labels });
    (opened[0] as { closed: boolean }).closed = true;
    vi.advanceTimersByTime(1500);
    expect(poppedOutIds$.value.size).toBe(0);
  });

  test("offers the volume in the window and follows it", () => {
    const playbackVolume$ = new BehaviorSubject(1);
    const adjustPlaybackVolume = vi.fn();
    const video = mockVideoTrack({
      mediaStreamTrack$: new BehaviorSubject<MediaStreamTrack | undefined>(
        fakeTrack(),
      ),
    });
    openPopout({
      id: "a",
      title: "A",
      video,
      labels,
      volume: {
        playbackVolume$,
        adjustPlaybackVolume,
        commitPlaybackVolume: vi.fn(),
        togglePlaybackMuted: vi.fn(),
      },
    });
    const slider = opened[0].document.querySelector("input")!;
    expect(slider.max).toBe("200");
    playbackVolume$.next(1.5);
    expect(slider.value).toBe("150");
    slider.value = "40";
    slider.dispatchEvent(new Event("input"));
    expect(adjustPlaybackVolume).toHaveBeenCalledWith(0.4);
  });

  test("says so when the popup is blocked", () => {
    open.mockReturnValue(null);
    expect(
      openPopout({ id: "a", title: "A", video: mockVideoTrack(), labels }),
    ).toBe(false);
  });
});

test("popoutWindowName keeps to characters a window name can carry", () => {
  expect(popoutWindowName("@a:b.c:camera")).toBe(
    "intercom-popout-_a_b_c_camera",
  );
});
