/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  availableSourceIds,
  effectiveFramerate,
  searchShareSources,
  selectAllShareSources,
  selectNoShareSources,
  shareAudioModes,
  shareAudioSummary,
  shareSourceCounts,
  shareSourceGroups,
  toggleShareSource,
} from "./shareDialogModel";

const sinks = [
  {
    name: "virtual-music",
    description: "Virtual Music",
    apps: ["Spotify", "mpv"],
    ownPlayback: false,
    source: "InterCom-Share-Music",
  },
  {
    name: "virtual-discord",
    description: "Virtual Discord",
    apps: ["InterCom"],
    ownPlayback: true,
  },
];
const inputs = {
  sinks,
  shareInputs: [
    { id: "d-music", label: "InterCom-Share-Music" },
    { id: "d-phone", label: "InterCom-Share-Phone" },
  ],
  audioInputs: [
    { id: "default", label: "Default" },
    { id: "mic", label: "Microphone" },
  ],
  mix: [
    { id: "sink:virtual-music", gain: 1.5, muted: true },
    { id: "sink:gone", gain: 1, muted: false },
  ],
  unavailableLabel: "Previously selected source",
};
const groups = shareSourceGroups(inputs);
const ids = (g = groups): string[][] => g.map((x) => x.rows.map((r) => r.id));

describe("the groups of a share's audio sources", () => {
  it("are outputs with their apps, share inputs, inputs, and what is gone", () => {
    expect(groups.map((g) => g.id)).toEqual([
      "outputs",
      "share-inputs",
      "inputs",
      "gone",
    ]);
    expect(ids()).toEqual([
      ["sink:virtual-music", "sink:virtual-discord"],
      // The input that carries a listed output is that output
      ["d-phone"],
      // The default device is one of the others
      ["mic"],
      ["sink:gone"],
    ]);
    expect(groups[0].rows[0]).toEqual({
      id: "sink:virtual-music",
      label: "Virtual Music",
      apps: ["Spotify", "mpv"],
      ownPlayback: false,
      selected: true,
      percent: 150,
      muted: true,
    });
    expect(groups[0].rows[1].ownPlayback).toBe(true);
    expect(groups[3].rows[0].label).toBe("gone");
  });

  it("leave out a group that has nothing, and the outputs where the host has none", () => {
    const bare = shareSourceGroups({ ...inputs, sinks: null, mix: [] });
    expect(bare.map((g) => g.id)).toEqual(["share-inputs", "inputs"]);
    // Without the output, the input that carried it is a source of its own
    expect(ids(bare)[0]).toEqual(["d-music", "d-phone"]);
    expect(
      shareSourceGroups({
        ...inputs,
        sinks: null,
        shareInputs: [],
        audioInputs: [],
        mix: [{ id: "x", gain: 1, muted: false }],
      })[0].rows[0].label,
    ).toBe("Previously selected source");
  });

  it("count what is picked", () => {
    expect(shareSourceCounts(groups)).toEqual({ selected: 2, total: 5 });
    expect(availableSourceIds(groups)).toEqual(
      new Set(["sink:virtual-music", "sink:virtual-discord", "d-phone", "mic"]),
    );
  });
});

describe("searching the sources", () => {
  it("finds by the source's name and by an app playing into it", () => {
    expect(ids(searchShareSources(groups, "spot"))).toEqual([
      ["sink:virtual-music"],
    ]);
    expect(ids(searchShareSources(groups, "  VIRTUAL "))).toEqual([
      ["sink:virtual-music", "sink:virtual-discord"],
    ]);
    // Every word must be found
    expect(ids(searchShareSources(groups, "virtual intercom"))).toEqual([
      ["sink:virtual-discord"],
    ]);
    expect(searchShareSources(groups, "nothing like it")).toEqual([]);
    expect(searchShareSources(groups, "   ")).toBe(groups);
  });
});

describe("picking sources", () => {
  const mix = inputs.mix;

  it("adds one at 100 % and takes one out", () => {
    expect(toggleShareSource(mix, "mic", true).at(-1)).toEqual({
      id: "mic",
      gain: 1,
      muted: false,
    });
    expect(toggleShareSource(mix, "sink:gone", false)).toEqual([mix[0]]);
    // Picked twice is picked once, as it was
    expect(toggleShareSource(mix, "sink:virtual-music", true)).toHaveLength(2);
  });

  it("all: everything that is there, the picked ones as they were", () => {
    const all = selectAllShareSources(mix, groups);
    expect(all.map((s) => s.id)).toEqual([
      "sink:virtual-music",
      "sink:gone",
      "sink:virtual-discord",
      "d-phone",
      "mic",
    ]);
    expect(all[0]).toBe(mix[0]);
  });

  it("all and none with a search on: only what the search shows", () => {
    const shown = searchShareSources(groups, "share-phone");
    expect(selectAllShareSources(mix, shown).map((s) => s.id)).toEqual([
      "sink:virtual-music",
      "sink:gone",
      "d-phone",
    ]);
    expect(
      selectNoShareSources(mix, searchShareSources(groups, "music")),
    ).toEqual([mix[1]]);
  });

  it("none: nothing, what is gone included", () => {
    expect(selectNoShareSources(mix, groups)).toEqual([]);
  });
});

describe("what the share will be", () => {
  it("offers the mode a system handles best first", () => {
    expect(shareAudioModes("linux")).toEqual(["none", "mix", "system"]);
    expect(shareAudioModes("windows")).toEqual(["none", "system", "mix"]);
    expect(shareAudioModes("macos")).toEqual(["none", "system", "mix"]);
  });

  it("takes the frame rate of the preset unless one was chosen", () => {
    expect(effectiveFramerate("sharp", 0)).toBe(30);
    expect(effectiveFramerate("motion", 0)).toBe(60);
    expect(effectiveFramerate("low", 0)).toBe(15);
    expect(effectiveFramerate("sharp", 120)).toBe(120);
  });

  it("sums the audio up by what is there to be heard", () => {
    const there = availableSourceIds(groups);
    expect(shareAudioSummary("none", inputs.mix, there)).toEqual({
      kind: "none",
    });
    expect(shareAudioSummary("system", inputs.mix, there)).toEqual({
      kind: "system",
    });
    // One of the two picked is gone, the other muted
    expect(shareAudioSummary("mix", inputs.mix, there)).toEqual({
      kind: "mix",
      count: 1,
      muted: 1,
    });
    expect(shareAudioSummary("mix", [], there)).toEqual({ kind: "none" });
  });
});
