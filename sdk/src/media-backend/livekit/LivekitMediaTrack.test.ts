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
     * element refuses anything outside [0, 1], as a real one does.
     */
    function volumeTrack(): FakeTrack & {
      element: { volume: number; muted: boolean };
      gain: number | undefined;
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
      let context: unknown;
      let remembered: number | undefined;
      const track = Object.assign(fakeTrack(), {
        element,
        gain: undefined as number | undefined,
      });
      track.setVolume.mockImplementation((v: number) => {
        if (context) track.gain = v;
        else element.volume = v;
        remembered = v;
      });
      track.setAudioContext.mockImplementation((ctx: unknown) => {
        if (context === ctx) return;
        context = ctx;
        if (ctx) {
          element.volume = 0;
          element.muted = true;
          track.gain = remembered ?? 1;
        } else {
          track.gain = undefined;
          element.muted = false;
          element.volume = remembered ?? 1;
        }
      });
      return track;
    }

    function audioTrack(livekitTrack: FakeTrack): AudioMediaTrack {
      const { participant, publication, room } = fakes({
        kind: Track.Kind.Audio,
        track: livekitTrack,
      });
      (
        room as unknown as { getActiveDevice: () => undefined }
      ).getActiveDevice = (): undefined => undefined;
      return createLivekitMediaTrack(
        scope,
        participant,
        publication as unknown as TrackPublication,
        room,
      ) as AudioMediaTrack;
    }

    beforeEach(() => {
      vi.stubGlobal(
        "AudioContext",
        class {
          public state = "running";
        },
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("is played through a gain node, the element silent", () => {
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      track.setVolume(1.29);
      expect(livekitTrack.gain).toBe(1.29);
      expect(livekitTrack.element.volume).toBe(0);
      track.setVolume(2);
      expect(livekitTrack.gain).toBe(2);
      expect(livekitTrack.element.volume).toBe(0);
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
      for (const v of [0.8, 1.1, 1.29, 2, 0.99, 1.01, 0, 1.5, 1]) {
        expect(() => track.setVolume(v)).not.toThrow();
        expect(livekitTrack.element.volume).toBeGreaterThanOrEqual(0);
        expect(livekitTrack.element.volume).toBeLessThanOrEqual(1);
      }
      expect(livekitTrack.element.volume).toBe(1);
    });

    it("stays within the element's range when the host takes its context away", () => {
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      const hostContext = {} as AudioContext;
      track.setAudioContext(hostContext, []);
      track.setVolume(1.6);
      expect(livekitTrack.gain).toBe(1.6);
      // Still louder than 1: the context of our own takes over
      expect(() => track.setAudioContext(undefined)).not.toThrow();
      expect(livekitTrack.gain).toBe(1.6);
      expect(livekitTrack.element.volume).toBe(0);
    });

    it("is capped at 1 on the element where there is no Web Audio", () => {
      vi.stubGlobal("AudioContext", undefined);
      const livekitTrack = volumeTrack();
      const track = audioTrack(livekitTrack);
      expect(() => track.setVolume(1.29)).not.toThrow();
      expect(livekitTrack.element.volume).toBe(1);
      expect(livekitTrack.gain).toBeUndefined();
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
