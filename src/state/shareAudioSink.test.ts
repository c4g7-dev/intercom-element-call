/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import {
  findDeviceByDescription,
  prepareSinkDevice,
  sinkChoice,
  sinkLabel,
  sinkOfChoice,
} from "./shareAudioSink";
import { type ShareAudioHost } from "../HostBridge";

const device = (
  label: string,
  deviceId: string,
  kind: MediaDeviceKind = "audioinput",
): Pick<MediaDeviceInfo, "kind" | "label" | "deviceId"> => ({
  kind,
  label,
  deviceId,
});

function host(description = "InterCom share: Virtual Music"): ShareAudioHost {
  return {
    listSinks: vi.fn(),
    prepareShareSource: vi.fn().mockResolvedValue({ description }),
    releaseShareSource: vi.fn().mockResolvedValue(undefined),
  };
}

describe("the sink choice", () => {
  it("round-trips a sink name and is told from every other choice", () => {
    expect(sinkOfChoice(sinkChoice("virtual-music"))).toBe("virtual-music");
    for (const other of ["none", "system", "abc123", "sink:", ""])
      expect(sinkOfChoice(other)).toBeUndefined();
  });

  it("labels a sink with what plays into it", () => {
    const sink = {
      name: "virtual-music",
      description: "Virtual Music",
      ownPlayback: false,
    };
    expect(sinkLabel({ ...sink, apps: ["Spotify", "mpv"] })).toBe(
      "Virtual Music — Spotify, mpv",
    );
    expect(sinkLabel({ ...sink, apps: [] })).toBe("Virtual Music");
  });
});

describe("findDeviceByDescription", () => {
  const devices = [
    device("Default - Mic", "default"),
    device("InterCom share: Virtual Music", "out", "audiooutput"),
    device("InterCom share: Virtual Music Two", "d2"),
    device("InterCom share: Virtual Music", "d1"),
  ];
  it("finds the audio input of that exact name first", () => {
    expect(
      findDeviceByDescription(devices, "InterCom share: Virtual Music"),
    ).toBe("d1");
  });
  it("accepts a name the browser added to", () => {
    expect(
      findDeviceByDescription(
        [device("InterCom share: Virtual Music (Virtual)", "d3")],
        "InterCom share: Virtual Music",
      ),
    ).toBe("d3");
  });
  it("finds nothing among other devices", () => {
    expect(findDeviceByDescription(devices, "Nope")).toBeUndefined();
  });
});

describe("prepareSinkDevice", () => {
  it("asks the host for the sink and waits for the device to be listed", async () => {
    const h = host();
    const enumerate = vi
      .fn()
      .mockResolvedValueOnce([device("Mic", "m")])
      .mockResolvedValueOnce([device("Mic", "m")])
      .mockResolvedValue([
        device("Mic", "m"),
        device("InterCom share: Virtual Music", "d1"),
      ]);
    await expect(
      prepareSinkDevice(h, "virtual-music", { enumerate, intervalMs: 1 }),
    ).resolves.toBe("d1");
    expect(h.prepareShareSource).toHaveBeenCalledWith("virtual-music");
    expect(enumerate).toHaveBeenCalledTimes(3);
  });

  it("gives up when the browser never lists the device", async () => {
    await expect(
      prepareSinkDevice(host(), "virtual-music", {
        enumerate: vi.fn().mockResolvedValue([]),
        timeoutMs: 5,
        intervalMs: 1,
      }),
    ).rejects.toThrow("does not list");
  });

  it("passes the host's refusal on without looking for a device", async () => {
    const h = host();
    vi.mocked(h.prepareShareSource).mockRejectedValue(
      new Error("No such sink"),
    );
    const enumerate = vi.fn();
    await expect(prepareSinkDevice(h, "nope", { enumerate })).rejects.toThrow(
      "No such sink",
    );
    expect(enumerate).not.toHaveBeenCalled();
  });
});
