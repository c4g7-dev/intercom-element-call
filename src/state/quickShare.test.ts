/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  availableShareSources,
  decideQuickShare,
  defaultShareAudio,
  missingSourceName,
  pressShare,
  setShareDialog,
  shareDialog$,
  shareNotice$,
  sharePlatform,
} from "./quickShare";

const base = {
  sharing: false,
  configured: true,
  canShowDialog: true,
  mode: "mix" as const,
  mix: [
    { id: "sink:music", gain: 1, muted: false },
    { id: "mic", gain: 0.5, muted: false },
  ],
};

afterEach(() => {
  setShareDialog(null);
  shareNotice$.next(null);
});

describe("what the share button does", () => {
  it("stops the share that is on, whatever else", () => {
    expect(
      decideQuickShare({ ...base, sharing: true, configured: false }),
    ).toEqual({ do: "stop" });
  });

  it("asks the first time on a device", () => {
    expect(decideQuickShare({ ...base, configured: false })).toEqual({
      do: "dialog",
    });
  });

  it("starts at once with saved settings", () => {
    expect(decideQuickShare(base)).toEqual({ do: "start", missing: [] });
    expect(
      decideQuickShare({
        ...base,
        available: new Set(["sink:music", "mic", "other"]),
      }),
    ).toEqual({ do: "start", missing: [] });
  });

  it("starts where no dialog can be shown, saved settings or not", () => {
    expect(
      decideQuickShare({ ...base, configured: false, canShowDialog: false }),
    ).toEqual({ do: "start", missing: [] });
  });

  it("starts without a saved source that is gone, and names it", () => {
    expect(decideQuickShare({ ...base, available: new Set(["mic"]) })).toEqual({
      do: "start",
      missing: ["sink:music"],
    });
    expect(missingSourceName("sink:music")).toBe("music");
    expect(missingSourceName("mic")).toBeUndefined();
  });

  it("misses nothing where the audio is not a mix", () => {
    for (const mode of ["none", "system"] as const)
      expect(
        decideQuickShare({ ...base, mode, available: new Set<string>() }),
      ).toEqual({ do: "start", missing: [] });
  });
});

describe("the defaults of a system", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterCom/1.12 Electron/39",
      "windows",
      "system",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/39",
      "macos",
      "system",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) InterCom/1.12 Electron/39",
      "linux",
      "none",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile",
      "other",
      "system",
    ],
    ["", "other", "system"],
  ] as const)("%s", (userAgent, platform, audio) => {
    expect(sharePlatform(userAgent)).toBe(platform);
    expect(defaultShareAudio(sharePlatform(userAgent))).toBe(audio);
  });
});

describe("pressing the share button", () => {
  it("opens the dialog and starts nothing the first time", () => {
    const toggle = vi.fn();
    expect(
      pressShare({ ...base, configured: false, toggle, source: "test" }),
    ).toBe("dialog");
    expect(toggle).not.toHaveBeenCalled();
    expect(shareDialog$.value).toBe("settings");
  });

  it("starts at once and says afterwards which source it went without", async () => {
    const toggle = vi.fn();
    expect(
      pressShare({
        ...base,
        toggle,
        source: "test",
        available: async () => Promise.resolve(new Set(["mic"])),
      }),
    ).toBe("start");
    // The share did not wait for the look at the sources
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(shareDialog$.value).toBeNull();
    await vi.waitFor(() => expect(shareNotice$.value).toEqual(["sink:music"]));
  });

  it("says nothing when everything is there, or when that cannot be told", async () => {
    for (const ids of [new Set(["mic", "sink:music"]), undefined]) {
      const available = vi.fn(async () => Promise.resolve(ids));
      pressShare({ ...base, toggle: vi.fn(), source: "test", available });
      await vi.waitFor(() => expect(available).toHaveBeenCalled());
      await Promise.resolve();
      expect(shareNotice$.value).toBeNull();
    }
  });

  it("stops without a look at the sources", () => {
    const toggle = vi.fn();
    const available = vi.fn();
    expect(
      pressShare({ ...base, sharing: true, toggle, source: "test", available }),
    ).toBe("stop");
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(available).not.toHaveBeenCalled();
  });
});

describe("the sources that are there", () => {
  const devices = (ids: string[], share: string[] = []) => ({
    audioInput: { available$: { value: new Map(ids.map((id) => [id, 0])) } },
    shareAudioSources$: { value: new Map(share.map((id) => [id, 0])) },
  });
  const host = (names: string[]) => ({
    listSinks: vi.fn().mockResolvedValue({
      supported: true,
      sinks: names.map((name) => ({ name })),
    }),
    prepareShareSource: vi.fn(),
    releaseShareSource: vi.fn(),
  });

  it("are the browser's inputs and the host's outputs", async () => {
    expect(
      await availableShareSources(host(["music"]), devices(["mic"], ["remap"])),
    ).toEqual(new Set(["mic", "remap", "sink:music"]));
    expect(await availableShareSources(undefined, devices(["mic"]))).toEqual(
      new Set(["mic"]),
    );
  });

  it("cannot be told while the browser lists no input, or the host does not answer", async () => {
    expect(await availableShareSources(host(["music"]), devices([]))).toBe(
      undefined,
    );
    const silent = host([]);
    silent.listSinks = vi.fn(async () => new Promise(() => {}));
    expect(await availableShareSources(silent, devices(["mic"]), 5)).toBe(
      undefined,
    );
  });
});
