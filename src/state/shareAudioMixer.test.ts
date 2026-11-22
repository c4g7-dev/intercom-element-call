/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createShareAudioMix,
  mixGain,
  mixSourceConstraints,
  ShareAudioMixer,
  shareAudioMixStatus$,
} from "./shareAudioMixer";
import { type ShareAudioHost } from "../HostBridge";
import { diagBuffer, diagOutput, resetDiag } from "../diagnostics/diag";
import { ObservableScope } from "./ObservableScope";
import {
  screenShareAudioMix,
  screenShareAudioSource,
} from "../settings/settings";

interface FakeNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}
interface FakeGain extends FakeNode {
  gain: { value: number };
}

function fakeTrack(): MediaStreamTrack & {
  stop: ReturnType<typeof vi.fn>;
  end: () => void;
} {
  const listeners: (() => void)[] = [];
  return {
    stop: vi.fn(),
    addEventListener: (_: string, listener: () => void) =>
      listeners.push(listener),
    end: () => listeners.forEach((l) => l()),
  } as never;
}

function fakeContext(): {
  context: AudioContext;
  destination: FakeNode & { stream: MediaStream; track: MediaStreamTrack };
  gains: FakeGain[];
  sources: (FakeNode & { stream: MediaStream })[];
  close: ReturnType<typeof vi.fn>;
} {
  const track = fakeTrack();
  const destination = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    channelCount: 0,
    track,
    stream: { getAudioTracks: () => [track] } as unknown as MediaStream,
  };
  const gains: FakeGain[] = [];
  const sources: (FakeNode & { stream: MediaStream })[] = [];
  const close = vi.fn().mockResolvedValue(undefined);
  const context = {
    state: "running",
    currentTime: 0,
    createMediaStreamDestination: () => destination,
    createGain: () => {
      const gain = {
        gain: { value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    },
    createMediaStreamSource: (stream: MediaStream) => {
      const source = { stream, connect: vi.fn(), disconnect: vi.fn() };
      sources.push(source);
      return source;
    },
    close,
  } as unknown as AudioContext;
  return { context, destination, gains, sources, close };
}

function setUp(host?: ShareAudioHost): {
  mixer: ShareAudioMixer;
  ctx: ReturnType<typeof fakeContext>;
  getUserMedia: ReturnType<
    typeof vi.fn<(c: MediaStreamConstraints) => Promise<MediaStream>>
  >;
  tracks: Map<string, ReturnType<typeof fakeTrack>>;
  prepareSink: ReturnType<typeof vi.fn>;
} {
  const ctx = fakeContext();
  const tracks = new Map<string, ReturnType<typeof fakeTrack>>();
  const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
    const deviceId = (
      (c.audio as MediaTrackConstraints).deviceId as { exact: string }
    ).exact;
    if (deviceId === "broken") throw new Error("NotReadableError");
    const track = fakeTrack();
    tracks.set(deviceId, track);
    return Promise.resolve({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
  });
  const prepareSink = vi.fn(async (_host: ShareAudioHost, sink: string) => {
    if (sink === "gone") throw new Error("No such sink");
    return Promise.resolve(`device-of-${sink}`);
  });
  const mixer = new ShareAudioMixer({
    host,
    createContext: () => ctx.context,
    getUserMedia,
    prepareSink,
  });
  return { mixer, ctx, getUserMedia, tracks, prepareSink };
}

function fakeHost(): ShareAudioHost {
  return {
    listSinks: vi.fn(),
    prepareShareSource: vi.fn(),
    releaseShareSource: vi.fn().mockResolvedValue(undefined),
  };
}

const source = (
  id: string,
  gain = 1,
  muted = false,
): { id: string; gain: number; muted: boolean } => ({ id, gain, muted });

const writeDiag = diagOutput.write;
beforeEach(() => {
  diagOutput.write = (): void => {};
  resetDiag();
});
afterEach(() => {
  diagOutput.write = writeDiag;
  shareAudioMixStatus$.next({});
});

describe("ShareAudioMixer", () => {
  it("has its one track from the start, before any source", () => {
    const { mixer, ctx, getUserMedia } = setUp();
    expect(mixer.track).toBe(ctx.destination.track);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(mixer.liveSources).toEqual([]);
  });

  it("opens every source raw and in stereo, each through a gain of its own into the one destination", async () => {
    const { mixer, ctx, getUserMedia } = setUp();
    await mixer.setSources([source("music", 0.5), source("games", 1.5)]);

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: mixSourceConstraints("music"),
    });
    expect(mixSourceConstraints("music")).toMatchObject({
      deviceId: { exact: "music" },
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
      channelCount: 2,
    });
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.gains.map((g) => g.gain.value)).toEqual([0.5, 1.5]);
    ctx.sources.forEach((s, i) =>
      expect(s.connect).toHaveBeenCalledWith(ctx.gains[i]),
    );
    for (const gain of ctx.gains)
      expect(gain.connect).toHaveBeenCalledWith(ctx.destination);
    expect(mixer.liveSources).toEqual(["music", "games"]);
    expect(shareAudioMixStatus$.value).toEqual({
      music: "live",
      games: "live",
    });
  });

  it("adds and removes sources on the same track, opening none twice", async () => {
    const { mixer, ctx, getUserMedia, tracks } = setUp();
    const track = mixer.track;
    await mixer.setSources([source("music")]);
    await mixer.setSources([source("music"), source("browser")]);
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    await mixer.setSources([source("browser")]);
    expect(tracks.get("music")!.stop).toHaveBeenCalled();
    expect(ctx.sources[0].disconnect).toHaveBeenCalled();
    expect(ctx.gains[0].disconnect).toHaveBeenCalled();
    expect(tracks.get("browser")!.stop).not.toHaveBeenCalled();
    expect(mixer.liveSources).toEqual(["browser"]);

    await mixer.setSources([]);
    expect(mixer.liveSources).toEqual([]);
    expect(mixer.track).toBe(track);
    expect(ctx.destination.track.stop).not.toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("changes gain and mute without reopening anything", async () => {
    const { mixer, ctx, getUserMedia } = setUp();
    await mixer.setSources([source("music", 1)]);
    await mixer.setSources([source("music", 2)]);
    expect(ctx.gains[0].gain.value).toBe(2);
    await mixer.setSources([source("music", 2, true)]);
    expect(ctx.gains[0].gain.value).toBe(0);
    await mixer.setSources([source("music", 0.3)]);
    expect(ctx.gains[0].gain.value).toBe(0.3);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(ctx.gains).toHaveLength(1);
  });

  it("keeps a gain between 0 and 2 and a source once", async () => {
    const { mixer, ctx, getUserMedia } = setUp();
    await mixer.setSources([
      source("music", 9),
      source("music", 0.1),
      source("games", -3),
    ]);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(ctx.gains.map((g) => g.gain.value)).toEqual([2, 0]);
    expect(mixGain(source("x", 1.4, true))).toBe(0);
  });

  it("has the host make a device of an output and lets go of it when it leaves the mix", async () => {
    const host = fakeHost();
    const { mixer, getUserMedia, prepareSink } = setUp(host);
    await mixer.setSources([source("sink:virtual-music"), source("mic")]);
    expect(prepareSink).toHaveBeenCalledWith(host, "virtual-music");
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: mixSourceConstraints("device-of-virtual-music"),
    });
    expect(host.releaseShareSource).not.toHaveBeenCalled();

    await mixer.setSources([source("mic")]);
    expect(host.releaseShareSource).toHaveBeenCalledWith("virtual-music");
  });

  it("leaves out a source that cannot be opened, keeps the rest, and tries again only once it was put back", async () => {
    const host = fakeHost();
    const { mixer, getUserMedia, prepareSink } = setUp(host);
    await mixer.setSources([
      source("broken"),
      source("sink:gone"),
      source("music"),
    ]);
    expect(mixer.liveSources).toEqual(["music"]);
    expect(shareAudioMixStatus$.value).toEqual({
      broken: "failed",
      "sink:gone": "failed",
      music: "live",
    });
    expect(host.releaseShareSource).toHaveBeenCalledWith("gone");

    // A gain change is no reason to try again
    await mixer.setSources([source("broken", 0.5), source("music")]);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(prepareSink).toHaveBeenCalledTimes(1);
    await mixer.setSources([source("music")]);
    await mixer.setSources([source("broken"), source("music")]);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
  });

  it("cannot mix an output without a host", async () => {
    const { mixer, getUserMedia } = setUp();
    await mixer.setSources([source("sink:virtual-music")]);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(shareAudioMixStatus$.value).toEqual({
      "sink:virtual-music": "failed",
    });
  });

  it("drops a source that was taken out while it was being opened", async () => {
    const { mixer, ctx, getUserMedia } = setUp();
    const track = fakeTrack();
    let opened!: (stream: MediaStream) => void;
    getUserMedia.mockImplementationOnce(
      async () => new Promise<MediaStream>((resolve) => (opened = resolve)),
    );
    const adding = mixer.setSources([source("music")]);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    const removing = mixer.setSources([]);
    opened({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await Promise.all([adding, removing]);
    expect(mixer.liveSources).toEqual([]);
    expect(track.stop).toHaveBeenCalled();
    expect(ctx.sources).toHaveLength(0);
  });

  it("marks a source whose device went away", async () => {
    const { mixer, tracks } = setUp();
    await mixer.setSources([source("music")]);
    tracks.get("music")!.end();
    expect(mixer.liveSources).toEqual([]);
    expect(shareAudioMixStatus$.value).toEqual({ music: "failed" });
  });

  it("stops every source, the track and the context when the share ends, and has the host release everything", async () => {
    const host = fakeHost();
    const { mixer, ctx, tracks, getUserMedia } = setUp(host);
    await mixer.setSources([source("music"), source("sink:virtual-games")]);
    mixer.close();
    mixer.close();

    expect(tracks.get("music")!.stop).toHaveBeenCalled();
    expect(tracks.get("device-of-virtual-games")!.stop).toHaveBeenCalled();
    expect(ctx.destination.track.stop).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(host.releaseShareSource).toHaveBeenCalledWith("virtual-games");
    expect(host.releaseShareSource).toHaveBeenCalledWith();
    expect(shareAudioMixStatus$.value).toEqual({});

    // Nothing is opened for a share that is over
    await mixer.setSources([source("browser")]);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(mixer.liveSources).toEqual([]);
  });

  it("records what changes, by kind and never by device id", async () => {
    const { mixer } = setUp(fakeHost());
    await mixer.setSources([
      source("secret-device-id"),
      source("sink:virtual-music"),
      source("broken"),
    ]);
    await mixer.setSources([]);
    const records = diagBuffer().filter((r) => r.type === "share_audio_source");
    expect(records.map((r) => [r.kind, r.sink, r.change])).toEqual(
      expect.arrayContaining([
        ["device", undefined, "added"],
        ["sink", "virtual-music", "added"],
        ["device", undefined, "failed"],
        ["device", undefined, "removed"],
        ["sink", "virtual-music", "removed"],
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("secret-device-id");
  });
});

describe("createShareAudioMix", () => {
  let scope: ObservableScope;
  beforeEach(() => {
    vi.useFakeTimers();
    scope = new ObservableScope();
    screenShareAudioSource.setValue("mix");
    screenShareAudioMix.setValue([source("music")]);
  });
  afterEach(() => {
    scope.end();
    vi.useRealTimers();
    screenShareAudioSource.setValue("system");
    screenShareAudioMix.setValue([]);
  });

  function control(): {
    mix: ReturnType<typeof createShareAudioMix>;
    mixers: {
      track: MediaStreamTrack;
      setSources: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }[];
    host: ShareAudioHost;
  } {
    const mixers: ReturnType<typeof control>["mixers"] = [];
    const host = fakeHost();
    const mix = createShareAudioMix(scope, host, (options) => {
      expect(options.host).toBe(host);
      const mixer = {
        track: fakeTrack(),
        setSources: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
      mixers.push(mixer);
      return mixer;
    });
    return { mix, mixers, host };
  }

  it("starts a mix of the chosen sources and hands out its track", () => {
    const { mix, mixers } = control();
    expect(mixers).toHaveLength(0);
    const track = mix.start();
    expect(track).toBe(mixers[0].track);
    expect(mixers[0].setSources).toHaveBeenCalledWith([source("music")]);
  });

  it("follows the settings while the share is on: the same track, no new mix", () => {
    const { mix, mixers } = control();
    const track = mix.start();

    screenShareAudioMix.setValue([
      source("music"),
      source("sink:virtual-games"),
    ]);
    expect(mixers[0].setSources).toHaveBeenLastCalledWith([
      source("music"),
      source("sink:virtual-games"),
    ]);
    screenShareAudioMix.setValue([source("sink:virtual-games", 1.7, true)]);
    expect(mixers[0].setSources).toHaveBeenLastCalledWith([
      source("sink:virtual-games", 1.7, true),
    ]);
    // "None" while sharing is a mix of nothing, on the track that is published
    screenShareAudioSource.setValue("none");
    expect(mixers[0].setSources).toHaveBeenLastCalledWith([]);
    screenShareAudioSource.setValue("mix");
    expect(mixers[0].setSources).toHaveBeenLastCalledWith([
      source("sink:virtual-games", 1.7, true),
    ]);

    expect(mixers).toHaveLength(1);
    expect(mixers[0].track).toBe(track);
    expect(mixers[0].close).not.toHaveBeenCalled();
  });

  it("publishes a silent mix for a share started without sound, to add to later", () => {
    screenShareAudioSource.setValue("none");
    const { mix, mixers } = control();
    expect(mix.start()).toBe(mixers[0].track);
    expect(mixers[0].setSources).toHaveBeenCalledWith([]);
  });

  it("leaves the picker's audio to the picker", () => {
    screenShareAudioSource.setValue("system");
    const { mix, mixers } = control();
    expect(mix.start()).toBeUndefined();
    expect(mixers).toHaveLength(0);
  });

  it("ends the mix with the share and with the call, and ignores the settings after", () => {
    const { mix, mixers } = control();
    mix.start();
    mix.end();
    mix.end();
    expect(mixers[0].close).toHaveBeenCalledTimes(1);
    screenShareAudioMix.setValue([]);
    expect(mixers[0].setSources).toHaveBeenCalledTimes(1);

    mix.start();
    scope.end();
    expect(mixers[1].close).toHaveBeenCalledTimes(1);
  });

  it("shares without sound where no mix can be made", () => {
    const mix = createShareAudioMix(scope, undefined, () => {
      throw new Error("no Web Audio");
    });
    expect(mix.start()).toBeUndefined();
    expect(diagBuffer().at(-1)).toMatchObject({
      type: "share_audio_mix",
      change: "failed",
    });
  });

  it("records the start, the end and each change once it has settled", () => {
    const { mix } = control();
    mix.start();
    for (const gain of [1.1, 1.2, 1.3])
      screenShareAudioMix.setValue([source("music", gain)]);
    vi.advanceTimersByTime(600);
    mix.end();
    expect(
      diagBuffer()
        .filter((r) => r.type === "share_audio_mix")
        .map((r) => [r.change, r.sources, r.gains]),
    ).toEqual([
      ["start", ["device"], undefined],
      ["update", ["device"], [130]],
      ["end", undefined, undefined],
    ]);
  });
});
