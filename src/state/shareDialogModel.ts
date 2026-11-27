/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ShareSink } from "../HostBridge";
import {
  type ScreenSharePreset,
  type ShareAudioMixSource,
} from "../settings/settings";
import { screenSharePresets } from "./screenShareOptions";
import {
  type ShareAudioMode,
  sinkChoice,
  sinkOfChoice,
} from "./shareAudioSink";
import { type SharePlatform } from "./quickShare";

/** A capture device with the name it is shown under. */
export interface NamedDevice {
  id: string;
  label: string;
}

export type ShareSourceGroupId =
  /** Outputs, with the applications playing into each */
  | "outputs"
  /** Inputs set up to carry an output's sound */
  | "share-inputs"
  /** Microphones and other inputs */
  | "inputs"
  /** Picked once and not there now */
  | "gone";

export interface ShareSourceRow {
  id: string;
  label: string;
  /** What plays into an output right now. */
  apps: string[];
  /** Whether the call itself plays into it: sharing it sends the call back. */
  ownPlayback: boolean;
  selected: boolean;
  /** 0 to 200 */
  percent: number;
  muted: boolean;
}

export interface ShareSourceGroup {
  id: ShareSourceGroupId;
  rows: ShareSourceRow[];
}

interface SourceInputs {
  /** null where the host has no outputs to offer */
  sinks: ShareSink[] | null;
  shareInputs: NamedDevice[];
  audioInputs: NamedDevice[];
  mix: ShareAudioMixSource[];
  /** What a source that is gone is called when it has no name of its own. */
  unavailableLabel: string;
}

/**
 * The sources a share's audio can be mixed from, in the groups they are
 * listed in. A group without sources is left out. What was picked and is
 * not there now is listed last, so that it can be dropped.
 */
export function shareSourceGroups({
  sinks,
  shareInputs,
  audioInputs,
  mix,
  unavailableLabel,
}: SourceInputs): ShareSourceGroup[] {
  const picked = new Map(mix.map((s) => [s.id, s]));
  const row = (
    id: string,
    label: string,
    apps: string[] = [],
    ownPlayback = false,
  ): ShareSourceRow => {
    const source = picked.get(id);
    return {
      id,
      label,
      apps,
      ownPlayback,
      selected: source !== undefined,
      percent: Math.round((source?.gain ?? 1) * 100),
      muted: source?.muted ?? false,
    };
  };
  const outputs = (sinks ?? []).map((sink) =>
    row(sinkChoice(sink.name), sink.description, sink.apps, sink.ownPlayback),
  );
  // An input that carries the sound of a listed output is that output
  const carried = new Set((sinks ?? []).map((sink) => sink.source));
  const share = shareInputs
    .filter((d) => !carried.has(d.label))
    .map((d) => row(d.id, d.label));
  const inputs = audioInputs
    // The default device is one of the others under another name
    .filter((d) => d.id !== "" && d.id !== "default")
    .map((d) => row(d.id, d.label));
  const known = new Set([...outputs, ...share, ...inputs].map((r) => r.id));
  const gone = mix
    .filter((s) => !known.has(s.id))
    .map((s) => row(s.id, sinkOfChoice(s.id) ?? unavailableLabel));
  const groups: ShareSourceGroup[] = [
    { id: "outputs", rows: outputs },
    { id: "share-inputs", rows: share },
    { id: "inputs", rows: inputs },
    { id: "gone", rows: gone },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

/** The ids of every source that is there to be picked. */
export function availableSourceIds(groups: ShareSourceGroup[]): Set<string> {
  return new Set(
    groups
      .filter((group) => group.id !== "gone")
      .flatMap((group) => group.rows.map((r) => r.id)),
  );
}

/**
 * The groups with only the sources a search finds: by the name of the
 * source, or of an application playing into it. Every word typed must be
 * found. An empty search finds everything.
 */
export function searchShareSources(
  groups: ShareSourceGroup[],
  query: string,
): ShareSourceGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return groups;
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((r) => {
        const text = [r.label, ...r.apps].join(" ").toLowerCase();
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((group) => group.rows.length > 0);
}

/** The mix with a source added (at 100 %) or taken out. */
export function toggleShareSource(
  mix: ShareAudioMixSource[],
  id: string,
  selected: boolean,
): ShareAudioMixSource[] {
  const without = mix.filter((s) => s.id !== id);
  return selected
    ? [
        ...without,
        mix.find((s) => s.id === id) ?? { id, gain: 1, muted: false },
      ]
    : without;
}

/**
 * The mix with every listed source that is there in it, each kept as it was
 * where it was in it already. With a search on, that is what the search
 * shows: the rest of the mix stays.
 */
export function selectAllShareSources(
  mix: ShareAudioMixSource[],
  shown: ShareSourceGroup[],
): ShareAudioMixSource[] {
  const have = new Set(mix.map((s) => s.id));
  const added = shown
    .filter((group) => group.id !== "gone")
    .flatMap((group) => group.rows)
    .filter((r) => !have.has(r.id))
    .map((r) => ({ id: r.id, gain: 1, muted: false }));
  return [...mix, ...added];
}

/** The mix without the listed sources, the ones that are gone included. */
export function selectNoShareSources(
  mix: ShareAudioMixSource[],
  shown: ShareSourceGroup[],
): ShareAudioMixSource[] {
  const drop = new Set(shown.flatMap((group) => group.rows.map((r) => r.id)));
  return mix.filter((s) => !drop.has(s.id));
}

/** How many of the listed sources are picked, and how many there are. */
export function shareSourceCounts(groups: ShareSourceGroup[]): {
  selected: number;
  total: number;
} {
  const rows = groups.flatMap((group) => group.rows);
  return {
    selected: rows.filter((r) => r.selected).length,
    total: rows.length,
  };
}

/**
 * The modes of a share's audio in the order they are offered: the one a
 * system handles best first.
 */
export function shareAudioModes(platform: SharePlatform): ShareAudioMode[] {
  return platform === "linux"
    ? ["none", "mix", "system"]
    : ["none", "system", "mix"];
}

/** The frame rate a share is sent at: the user's own, or the preset's. */
export function effectiveFramerate(
  preset: ScreenSharePreset,
  customFramerate: number,
): number {
  return customFramerate > 0
    ? customFramerate
    : screenSharePresets[preset].framerate;
}

/** The frame rates offered; 0 is the preset's own. */
export const FRAMERATE_CHOICES = [0, 15, 30, 60, 120];

/** What the line above the share button says about the audio. */
export type ShareAudioSummary =
  | { kind: "none" }
  | { kind: "system" }
  | { kind: "mix"; count: number; muted: number };

export function shareAudioSummary(
  mode: ShareAudioMode,
  mix: ShareAudioMixSource[],
  available: ReadonlySet<string>,
): ShareAudioSummary {
  if (mode !== "mix") return { kind: mode };
  const there = mix.filter((s) => available.has(s.id));
  // A mix of nothing is no sound
  if (there.length === 0) return { kind: "none" };
  return {
    kind: "mix",
    count: there.length,
    muted: there.filter((s) => s.muted || s.gain === 0).length,
  };
}
