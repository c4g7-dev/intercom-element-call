/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "events";
import {
  type LocalParticipant,
  LocalVideoTrack,
  ParticipantEvent,
  RemoteAudioTrack,
  type RemoteParticipant,
  type Room as LivekitRoom,
  RoomEvent,
  Track,
  TrackEvent,
  type TrackPublication,
} from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ObservableScope } from "../../reactive/ObservableScope";
import {
  type AudioMediaTrack,
  type LocalVideoMediaTrack,
  type VideoProcessor,
} from "../../media-api";
import {
  createLivekitMediaTrack,
  createLocalLivekitMediaTrack,
  elementVolume,
  LIMITER_SETTINGS,
} from "./LivekitMediaTrack";

describe("createLivekitMediaTrack", () => {
  let scope: ObservableScope;
  beforeEach(() => {
    scope = new ObservableScope();
  });
  afterEach(() => {
    scope.end();
    vi.useRealTimers();
  });

  it("describes the publication", () => {
    const { participant, publication, room } = fakes();
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    );
    expect(track.kind).toBe("video");
    expect(track.source).toBe("camera");
    expect(track.id).toBe("TR_1");
    expect(track.encrypted).toBe(true);
  });

  it("attaches elements to the track, even one that arrives later", () => {
    const { participant, publication, room, emitter } = fakes({
      track: undefined,
    });
    const element = document.createElement("video");
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    );
    track.attach(element);
    track.attach(element);

    const livekitTrack = fakeTrack();
    publication.track = livekitTrack;
    emitter.emit(TrackEvent.Subscribed, livekitTrack);
    expect(livekitTrack.attach).toHaveBeenCalledTimes(1);
    expect(livekitTrack.attach).toHaveBeenCalledWith(element);

    track.detach(element);
    expect(livekitTrack.detach).toHaveBeenCalledWith(element);
  });

  it("detaches everything when its scope ends", () => {
    const { participant, publication, room } = fakes();
    const element = document.createElement("video");
    const scope = new ObservableScope();
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    );
    track.attach(element);
    scope.end();
    expect(publication.track!.detach).toHaveBeenCalledWith(element);
  });

  it("follows the mute state", () => {
    const { participant, publication, room, emitter } = fakes();
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    );
    expect(track.muted$.value).toBe(false);
    publication.isMuted = true;
    emitter.emit(ParticipantEvent.TrackMuted, publication);
    expect(track.muted$.value).toBe(true);
  });

  it("scales a remote member's volume on the participant", () => {
    const { participant, publication, room } = fakes({
      kind: Track.Kind.Audio,
    });
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    ) as AudioMediaTrack;
    track.setVolume(0.5);
    expect(publication.track!.setVolume).toHaveBeenCalledWith(0.5);
  });

  describe("a volume above 1", () => {
    /**
     * LiveKit's RemoteAudioTrack as far as volume goes: it remembers the last
     * volume, writes it to the elements off a context and to a gain node on
     * one, and gives it back to the elements when the context goes. The
     * element refuses anything outside [0, 1], as a real one does. On a
     * context it builds its graph anew for every change of context or
     * plugins, which `connects` counts, and refuses plugins of another one.
     */
    function volumeTrack(): FakeTrack & {
      element: { volume: number; muted: boolean };
      gain: number | undefined;
      context: unknown;
      plugins: FakeNode[];
      connects: number;
    } {
      let elementVolume = 1;
      const element = {
        muted: false,
        get volume(): number {
          return elementVolume;
        },
        set volume(v: number) {
          if (!(v >= 0 && v <= 1))
            throw new DOMException(
              `The volume provided (${v}) is outside the range [0, 1]`,
              "IndexSizeError",
            );
          elementVolume = v;
        },
      };
      let remembered: number | undefined;
      const track = Object.assign(fakeTrack(), {
        element,
        gain: undefined as number | undefined,
        context: undefined as unknown,
        plugins: [] as FakeNode[],
        connects: 0,
      });
      const connect = (): void => {
        for (const node of track.plugins)
          if (node.context !== track.context)
            throw new DOMException(
              "cannot connect to an AudioNode belonging to a different audio context",
              "InvalidAccessError",
            );
        track.connects++;
        track.gain = remembered ?? 1;
      };
      track.setVolume.mockImplementation((v: number) => {
        if (track.context) track.gain = v;
        else element.volume = v;
        remembered = v;
      });
      track.setAudioContext.mockImplementation((ctx: unknown) => {
        if (track.context === ctx) return;
        track.context = ctx;
        if (ctx) {
          element.volume = 0;
          element.muted = true;
          connect();
        } else {
          track.gain = undefined;
          element.muted = false;
          element.volume = remembered ?? 1;
        }
      });
      track.setWebAudioPlugins.mockImplementation((nodes: FakeNode[]) => {
        track.plugins = nodes;
        if (track.context) connect();
      });
      return track;
    }

    interface FakeParam {
      value: number;
      target: number | undefined;
      timeConstant: number | undefined;
      cancelScheduledValues: () => void;
      setTargetAtTime: (target: number, at: number, constant: number) => void;
    }
    interface FakeNode {
      kind: "gain" | "limiter";
      context: unknown;
      gain: FakeParam;
      threshold: FakeParam;
      knee: FakeParam;
      ratio: FakeParam;
      attack: FakeParam;
      release: FakeParam;
    }
    function fakeParam(value: number): FakeParam {
      const param: FakeParam = {
        value,
        target: undefined,
        timeConstant: undefined,
        cancelScheduledValues: () => {},
        setTargetAtTime: (target, _at, constant) => {
          param.target = target;
          param.timeConstant = constant;
        },
      };
      return param;
    }
    function fakeNode(kind: FakeNode["kind"], context: unknown): FakeNode {
      return {
        kind,
        context,
        gain: fakeParam(1),
        threshold: fakeParam(-24),
        knee: fakeParam(30),
        ratio: fakeParam(12),
        attack: fakeParam(0.003),
        release: fakeParam(0.25),
      };
    }
    class FakeAudioContext {
      public static made: FakeAudioContext[] = [];
      public state = "running";
      public currentTime = 0;
      public sinkId = "";
      public setSinkId = vi.fn(async (id: string) => {
        this.sinkId = id;
        return Promise.resolve();
      });
      public constructor() {
        FakeAudioContext.made.push(this);
      }
      public createGain(): FakeNode {
        return fakeNode("gain", this);
      }
      public createDynamicsCompressor(): FakeNode {
        return fakeNode("limiter", this);
      }
    }

    let outputDevice: string | undefined;
    let room: LivekitRoom;
    function audioTrack(livekitTrack: FakeTrack): AudioMediaTrack {
      const f = fakes({ kind: Track.Kind.Audio, track: livekitTrack });
      room = f.room;
      (
        room as unknown as { getActiveDevice: () => string | undefined }
      ).getActiveDevice = (): string | undefined => outputDevice;
      return createLivekitMediaTrack(
        scope,
        f.participant,
        f.publication as unknown as TrackPublication,
        room,
      ) as AudioMediaTrack;
    }
    const boostGain = (t: { plugins: FakeNode[] }): FakeNode | undefined =>
      t.plugins.find((n) => n.kind === "gain");
    const limiter = (t: { plugins: FakeNode[] }): FakeNode | undefined =>
      t.plugins.find((n) => n.kind === "limiter");

    beforeEach(() => {
      outputDevice = undefined;
      FakeAudioContext.made = [];
      vi.stubGlobal("AudioContext", FakeAudioContext);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("is played through a gain node of its own, the element silent", () => {
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      track.setVolume(1.29);
      expect(boostGain(livekitTrack)?.gain.target).toBe(1.29);
      // LiveKit's gain node comes after the limiter and adds nothing
      expect(livekitTrack.gain).toBe(1);
      expect(livekitTrack.element.volume).toBe(0);
      track.setVolume(4);
      expect(boostGain(livekitTrack)?.gain.target).toBe(4);
      expect(livekitTrack.gain).toBe(1);
      expect(livekitTrack.element.volume).toBe(0);
    });

    it("has a limiter right behind the gain, and only above 1", () => {
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      track.setVolume(0.8);
      expect(livekitTrack.plugins).toEqual([]);
      expect(livekitTrack.context).toBeUndefined();
      track.setVolume(1);
      expect(livekitTrack.plugins).toEqual([]);
      expect(livekitTrack.context).toBeUndefined();
      expect(FakeAudioContext.made).toHaveLength(0);

      track.setVolume(2.5);
      expect(livekitTrack.plugins.map((n) => n.kind)).toEqual([
        "gain",
        "limiter",
      ]);
      const node = limiter(livekitTrack)!;
      expect(node.threshold.value).toBe(LIMITER_SETTINGS.threshold);
      expect(node.knee.value).toBe(LIMITER_SETTINGS.knee);
      expect(node.ratio.value).toBe(20);
      expect(node.attack.value).toBe(0.002);
      expect(node.release.value).toBe(0.1);

      track.setVolume(0.9);
      expect(livekitTrack.plugins).toEqual([]);
      expect(livekitTrack.context).toBeUndefined();
      expect(livekitTrack.element.volume).toBe(0.9);
    });

    it("follows a drag with ramps on the same graph, without building it again", () => {
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      track.setVolume(1.1);
      expect(livekitTrack.connects).toBe(1);
      const node = boostGain(livekitTrack)!;
      for (const v of [1.2, 1.7, 2.4, 3.98, 3, 1.05]) {
        track.setVolume(v);
        expect(node.gain.target).toBe(v);
        expect(node.gain.timeConstant).toBeGreaterThan(0);
        expect(node.gain.timeConstant).toBeLessThanOrEqual(0.05);
      }
      expect(boostGain(livekitTrack)).toBe(node);
      expect(livekitTrack.connects).toBe(1);
    });

    it("does not build the graph again for a volume at or below 1 either", () => {
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      for (const v of [0.2, 0.5, 1, 0]) track.setVolume(v);
      expect(livekitTrack.setWebAudioPlugins).toHaveBeenCalledTimes(1);
      expect(livekitTrack.connects).toBe(0);
    });

    it("plays on the room's output device, and follows it", () => {
      outputDevice = "headset";
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      track.setVolume(1.5);
      const context = livekitTrack.context as FakeAudioContext;
      expect(context.setSinkId).toHaveBeenLastCalledWith("headset");

      outputDevice = "speakers";
      (room as unknown as EventEmitter).emit(
        RoomEvent.ActiveDeviceChanged,
        "audiooutput",
        "speakers",
      );
      expect(context.setSinkId).toHaveBeenLastCalledWith("speakers");
      outputDevice = "default";
      (room as unknown as EventEmitter).emit(
        RoomEvent.ActiveDeviceChanged,
        "audiooutput",
        "default",
      );
      expect(context.setSinkId).toHaveBeenLastCalledWith("");
      // Not for a microphone
      context.setSinkId.mockClear();
      (room as unknown as EventEmitter).emit(
        RoomEvent.ActiveDeviceChanged,
        "audioinput",
        "mic",
      );
      expect(context.setSinkId).not.toHaveBeenCalled();
    });

    it.each([1, 0.4, 0])(
      "goes back to the element at %s without giving it more than 1",
      (lower) => {
        const livekitTrack = volumeTrack();
        const track = audioTrack(livekitTrack);
        track.setVolume(1.29);
        expect(() => track.setVolume(lower)).not.toThrow();
        expect(livekitTrack.gain).toBeUndefined();
        expect(livekitTrack.element.muted).toBe(false);
        expect(livekitTrack.element.volume).toBe(lower);
      },
    );

    it("survives the slider being dragged up and down across 1", () => {
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      for (const v of [0.8, 1.1, 1.29, 4, 0.99, 1.01, 0, 1.5, 1]) {
        expect(() => track.setVolume(v)).not.toThrow();
        expect(livekitTrack.element.volume).toBeGreaterThanOrEqual(0);
        expect(livekitTrack.element.volume).toBeLessThanOrEqual(1);
      }
      expect(livekitTrack.element.volume).toBe(1);
    });

    it("boosts on the host's context behind its plugins, and on its own when that goes", () => {
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      const hostContext = new FakeAudioContext();
      const pan = fakeNode("gain", hostContext);
      track.setAudioContext(
        hostContext as unknown as AudioContext,
        [pan] as unknown as AudioNode[],
      );
      track.setVolume(0.5);
      expect(livekitTrack.plugins).toEqual([pan]);
      expect(livekitTrack.gain).toBe(0.5);

      track.setVolume(1.6);
      expect(livekitTrack.context).toBe(hostContext);
      expect(livekitTrack.plugins[0]).toBe(pan);
      expect(livekitTrack.plugins.slice(1).map((n) => n.kind)).toEqual([
        "gain",
        "limiter",
      ]);
      expect(livekitTrack.plugins[1].gain.target).toBe(1.6);
      expect(livekitTrack.gain).toBe(1);

      // Still louder than 1: the context of our own takes over, with nodes
      // of its own
      expect(() => track.setAudioContext(undefined)).not.toThrow();
      expect(livekitTrack.context).not.toBe(hostContext);
      expect(livekitTrack.context).toBeDefined();
      expect(livekitTrack.plugins.map((n) => n.kind)).toEqual([
        "gain",
        "limiter",
      ]);
      expect(livekitTrack.plugins[0].context).toBe(livekitTrack.context);
      expect(livekitTrack.plugins[0].gain.target).toBe(1.6);
      expect(livekitTrack.element.volume).toBe(0);
    });

    it("is capped at 1 on the element where there is no Web Audio", () => {
      vi.stubGlobal("AudioContext", undefined);
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      expect(() => track.setVolume(1.29)).not.toThrow();
      expect(livekitTrack.element.volume).toBe(1);
      expect(livekitTrack.gain).toBeUndefined();
      expect(livekitTrack.plugins).toEqual([]);
    });

    it("ignores a volume that is not a number and floors a negative one", () => {
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      expect(() => track.setVolume(NaN)).not.toThrow();
      expect(livekitTrack.element.volume).toBe(1);
      expect(() => track.setVolume(-0.5)).not.toThrow();
      expect(livekitTrack.element.volume).toBe(0);
    });

    it("maps a gain to an element volume within [0, 1]", () => {
      expect(elementVolume(1.29)).toBe(1);
      expect(elementVolume(2)).toBe(1);
      expect(elementVolume(0.3)).toBe(0.3);
      expect(elementVolume(-1)).toBe(0);
      expect(elementVolume(NaN)).toBe(1);
    });
  });

  it("is active while the member speaks and the track is not muted", () => {
    const { participant, publication, room, emitter } = fakes({
      kind: Track.Kind.Audio,
    });
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    ) as AudioMediaTrack;
    expect(track.isActive$.value).toBe(false);
    participant.isSpeaking = true;
    emitter.emit(ParticipantEvent.IsSpeakingChanged, true);
    expect(track.isActive$.value).toBe(true);
    publication.isMuted = true;
    emitter.emit(ParticipantEvent.TrackMuted, publication);
    expect(track.isActive$.value).toBe(false);
  });

  it("reports the audio level the room announces, 0 while muted", () => {
    const { participant, publication, room, emitter } = fakes({
      kind: Track.Kind.Audio,
    });
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    ) as AudioMediaTrack;
    expect(track.audioLevel$.value).toBe(0);
    participant.audioLevel = 0.4;
    (room as unknown as EventEmitter).emit(RoomEvent.ActiveSpeakersChanged, [
      participant,
    ]);
    expect(track.audioLevel$.value).toBe(0.4);
    publication.isMuted = true;
    emitter.emit(ParticipantEvent.TrackMuted, publication);
    expect(track.audioLevel$.value).toBe(0);
  });

  it("polls statistics at the given interval, only while subscribed", async () => {
    vi.useFakeTimers();
    const { participant, publication, room } = fakes();
    const stats = { type: "inbound-rtp" } as RTCInboundRtpStreamStats;
    publication.track!.getRTCStatsReport.mockResolvedValue(
      new Map([["s", stats]]),
    );
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    );
    const stats$ = track.stats$(500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(publication.track!.getRTCStatsReport).not.toHaveBeenCalled();

    const seen = vi.fn();
    const subscription = stats$.subscribe(seen);
    await vi.advanceTimersByTimeAsync(0);
    expect(publication.track!.getRTCStatsReport).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith(stats);
    await vi.advanceTimersByTimeAsync(1000);
    expect(publication.track!.getRTCStatsReport).toHaveBeenCalledTimes(3);

    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publication.track!.getRTCStatsReport).toHaveBeenCalledTimes(3);
  });

  it("reads a remote track's diagnostics: the whole report, the track and what was published", async () => {
    const { participant, publication, room } = fakes();
    const mediaStreamTrack = {
      contentHint: "",
      readyState: "live",
      enabled: true,
      muted: false,
      label: "remote video",
      getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
    };
    Object.assign(publication.track!, { _mediaStreamTrack: mediaStreamTrack });
    publication.track!.getRTCStatsReport.mockResolvedValue(
      new Map([
        ["a", { type: "inbound-rtp", frameWidth: 1280 }],
        ["b", { type: "codec", mimeType: "video/VP8" }],
      ]),
    );
    Object.assign(publication, {
      simulcasted: true,
      dimensions: { width: 1280, height: 720 },
      trackInfo: {
        layers: [{ quality: 2, width: 1280, height: 720, bitrate: 1_700_000 }],
      },
    });
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    );
    await expect(track.diagnostics()).resolves.toEqual({
      stats: [
        { type: "inbound-rtp", frameWidth: 1280 },
        { type: "codec", mimeType: "video/VP8" },
      ],
      track: {
        contentHint: "",
        readyState: "live",
        enabled: true,
        muted: false,
        label: "remote video",
        width: 1280,
        height: 720,
        frameRate: 30,
        sampleRate: undefined,
        channelCount: undefined,
      },
      published: {
        simulcast: true,
        width: 1280,
        height: 720,
        layers: [{ quality: 2, width: 1280, height: 720, bitrate: 1_700_000 }],
      },
    });
  });

  it("reads our own track's diagnostics with what the sender was told to encode", async () => {
    const sender = {
      getParameters: () => ({
        degradationPreference: "maintain-resolution",
        encodings: [
          { active: true, maxBitrate: 8_000_000, scaleResolutionDownBy: 2 },
        ],
      }),
    };
    const local = Object.assign(Object.create(LocalVideoTrack.prototype), {
      _isUpstreamPaused: false,
      _mediaStreamTrack: {
        contentHint: "detail",
        readyState: "live",
        enabled: true,
        muted: false,
        label: "screen",
        getSettings: () => ({}),
      },
      getRTCStatsReport: vi.fn().mockResolvedValue(undefined),
      sender,
    }) as LocalVideoTrack;
    const { participant, publication, room } = fakes({
      track: local as unknown as FakeTrack,
    });
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    );
    const diagnostics = await track.diagnostics();
    expect(diagnostics?.stats).toEqual([]);
    expect(diagnostics?.track?.contentHint).toBe("detail");
    expect(diagnostics?.sender).toEqual({
      degradationPreference: "maintain-resolution",
      encodings: [
        {
          active: true,
          maxBitrate: 8_000_000,
          scaleResolutionDownBy: 2,
          rid: undefined,
          maxFramerate: undefined,
          scalabilityMode: undefined,
          priority: undefined,
        },
      ],
      upstreamPaused: false,
    });
    expect(diagnostics?.subscription).toBeUndefined();
  });

  it("has no diagnostics while there is no track", async () => {
    const { participant, publication, room } = fakes();
    publication.track = undefined;
    const track = createLivekitMediaTrack(
      scope,
      participant,
      publication as unknown as TrackPublication,
      room,
    );
    await expect(track.diagnostics()).resolves.toBeUndefined();
  });

  it("gives our own track its controls", async () => {
    const { participant, publication, room } = fakes({
      kind: Track.Kind.Audio,
    });
    const setEnabled = vi.fn().mockResolvedValue(false);
    const switchActiveDevice = vi.fn().mockResolvedValue(true);
    const track = createLocalLivekitMediaTrack(
      scope,
      Object.assign(participant, {
        isLocal: true,
      }) as unknown as LocalParticipant,
      publication as unknown as TrackPublication,
      Object.assign(room, { switchActiveDevice }),
      setEnabled,
    );
    await expect(track.setEnabled(false)).resolves.toBe(false);
    expect(setEnabled).toHaveBeenCalledWith("microphone", false);
    await track.setDevice("mic-2");
    expect(switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-2");
  });

  // LiveKit's media stream track is the processed one while a processor runs,
  // and that one names no device; the camera behind it does
  it.each([
    { deviceId: "cam-1", switches: false },
    { deviceId: "cam-2", switches: true },
  ])(
    "leaves a processed camera alone unless its device changes: $deviceId",
    async ({ deviceId, switches }) => {
      let openDevice = "cam-1";
      const camera = Object.assign(Object.create(LocalVideoTrack.prototype), {
        source: Track.Source.Camera,
        _mediaStreamTrack: {
          readyState: "live",
          label: "",
          getSettings: () => ({ deviceId: openDevice }),
        },
        // What LiveKit shows as the track, with no device of its own
        processor: {
          processedTrack: { label: "", getSettings: () => ({}) },
        },
      }) as LocalVideoTrack;
      const switchActiveDevice = vi.fn(async (_kind: string, id: string) => {
        openDevice = id;
        return Promise.resolve(true);
      });
      const { participant, publication, room } = fakes({
        track: camera as unknown as FakeTrack,
      });
      const track = createLocalLivekitMediaTrack(
        scope,
        Object.assign(participant, {
          isLocal: true,
        }) as unknown as LocalParticipant,
        publication as unknown as TrackPublication,
        Object.assign(room, { switchActiveDevice }),
        vi.fn(),
      );

      await track.setDevice(deviceId);
      expect(switchActiveDevice.mock.calls).toEqual(
        switches ? [["videoinput", deviceId]] : [],
      );
    },
  );

  it("rejects where the camera did not move to the device asked for", async () => {
    const camera = Object.assign(Object.create(LocalVideoTrack.prototype), {
      source: Track.Source.Camera,
      _mediaStreamTrack: {
        readyState: "live",
        label: "",
        getSettings: () => ({ deviceId: "cam-1" }),
      },
    }) as LocalVideoTrack;
    const { participant, publication, room } = fakes({
      track: camera as unknown as FakeTrack,
    });
    const track = createLocalLivekitMediaTrack(
      scope,
      Object.assign(participant, {
        isLocal: true,
      }) as unknown as LocalParticipant,
      publication as unknown as TrackPublication,
      Object.assign(room, {
        switchActiveDevice: vi.fn().mockResolvedValue(true),
      }),
      vi.fn(),
    );

    await expect(track.setDevice("cam-2")).rejects.toThrow("another device");
  });

  it("takes the facing mode of a processed camera from the camera", async () => {
    const source = {
      readyState: "live",
      label: "Back Camera",
      getSettings: () => ({ facingMode: "environment" }),
    };
    const camera = Object.assign(Object.create(LocalVideoTrack.prototype), {
      source: Track.Source.Camera,
      _mediaStreamTrack: source,
      mediaStream: { getVideoTracks: () => [source] },
      processor: {
        processedTrack: { label: "", getSettings: () => ({}) },
      },
      restartTrack: vi.fn().mockResolvedValue(undefined),
    }) as LocalVideoTrack;
    const { participant, publication, room } = fakes({
      track: camera as unknown as FakeTrack,
    });
    const track = createLocalLivekitMediaTrack(
      scope,
      Object.assign(participant, {
        isLocal: true,
      }) as unknown as LocalParticipant,
      publication as unknown as TrackPublication,
      room,
      vi.fn(),
    ) as LocalVideoMediaTrack;

    expect(track.facingMode$.value).toBe("environment");
    await track.switchFacingMode();
    expect(camera.restartTrack).toHaveBeenCalledExactlyOnceWith({
      facingMode: "user",
    });
  });

  // LiveKit stops a camera that is turned off; the processor is built when it
  // is turned on again
  it.each([
    { state: "is off", isMuted: true, takes: true },
    { state: "has stopped for good", isMuted: false, takes: false },
  ])(
    "gives a processor to a camera that $state: $takes",
    async ({ isMuted, takes }) => {
      // jsdom has none; LiveKit's facing mode checks against it
      const camera = Object.assign(Object.create(LocalVideoTrack.prototype), {
        isMuted,
        _mediaStreamTrack: {
          readyState: "ended",
          label: "",
          getSettings: () => ({}),
        },
        getProcessor: () => undefined,
        setProcessor: vi.fn().mockResolvedValue(undefined),
      }) as LocalVideoTrack;
      const { participant, publication, room } = fakes({
        track: camera as unknown as FakeTrack,
      });
      const track = createLocalLivekitMediaTrack(
        scope,
        Object.assign(participant, {
          isLocal: true,
        }) as unknown as LocalParticipant,
        publication as unknown as TrackPublication,
        room,
        vi.fn(),
      ) as LocalVideoMediaTrack;

      await track.setProcessor({ name: "blur" } as VideoProcessor);
      expect(vi.mocked(camera.setProcessor).mock.calls.length).toBe(
        takes ? 1 : 0,
      );
    },
  );
});

type FakeTrack = Track & {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
  setAudioContext: ReturnType<typeof vi.fn>;
  setWebAudioPlugins: ReturnType<typeof vi.fn>;
  getRTCStatsReport: ReturnType<typeof vi.fn>;
};

type FakePublication = Omit<TrackPublication, "track" | "isMuted"> & {
  track: FakeTrack | undefined;
  isMuted: boolean;
};

function fakeTrack(): FakeTrack {
  return Object.assign(Object.create(RemoteAudioTrack.prototype), {
    attach: vi.fn(),
    detach: vi.fn(),
    setVolume: vi.fn(),
    setAudioContext: vi.fn(),
    setWebAudioPlugins: vi.fn(),
    getRTCStatsReport: vi.fn().mockResolvedValue(undefined),
  }) as FakeTrack;
}

function fakes({
  track = fakeTrack(),
  kind = Track.Kind.Video,
}: { track?: FakeTrack | undefined; kind?: Track.Kind } = {}): {
  participant: RemoteParticipant & { isSpeaking: boolean; audioLevel: number };
  publication: FakePublication;
  room: LivekitRoom;
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  const participant = Object.assign(emitter, {
    isLocal: false,
    isSpeaking: false,
    audioLevel: 0,
    identity: "@alice:example.org:DEVICE",
    getTrackPublication: (): TrackPublication =>
      publication as unknown as TrackPublication,
  }) as unknown as RemoteParticipant & {
    isSpeaking: boolean;
    audioLevel: number;
  };
  const publication = Object.assign(emitter, {
    kind,
    source:
      kind === Track.Kind.Audio ? Track.Source.Microphone : Track.Source.Camera,
    trackSid: "TR_1",
    isMuted: false,
    isEncrypted: true,
    track,
  }) as unknown as FakePublication;
  const room = new EventEmitter() as unknown as LivekitRoom;
  return { participant, publication, room, emitter };
}
