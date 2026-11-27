/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type FC, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SearchIcon,
  VolumeOffSolidIcon,
  VolumeOnSolidIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useMediaDevices } from "../MediaDevicesContext";
import { useBehavior } from "../useBehavior";
import { constant } from "../state/Behavior";
import {
  screenShareAudioMix,
  screenShareAudioSource,
  type ShareAudioMixSource,
  useSetting,
} from "../settings/settings";
import { type ShareSink, useHostBridge } from "../HostBridge";
import {
  sanitizeMix,
  shareAudioMix,
  shareAudioMode,
  type ShareAudioMode,
  sinkChoice,
  sinkOfChoice,
} from "../state/shareAudioSink";
import { shareAudioMixStatus$ } from "../state/shareAudioMixer";
import { diag } from "../diagnostics/diag";
import { type DeviceLabel } from "../state/MediaDevices";
import {
  type NamedDevice,
  searchShareSources,
  selectAllShareSources,
  selectNoShareSources,
  shareAudioModes,
  type ShareSourceGroupId,
  shareSourceCounts,
  shareSourceGroups,
  toggleShareSource,
} from "../state/shareDialogModel";
import { sharePlatform } from "../state/quickShare";
import styles from "./ShareAudioSources.module.css";

interface Props {
  /**
   * Whether a share is on: the sources then change as they are picked, and
   * the picker's own audio, which only a new capture can add or drop, is no
   * longer a choice.
   */
  live: boolean;
}

const noDevices = constant(new Map<string, DeviceLabel>());

/**
 * The outputs the host can make a share's audio of, with what is playing
 * into each: asked again every few seconds, as that changes. Null where the
 * host has none to offer.
 */
export function useShareSinks(): ShareSink[] | null {
  const shareAudio = useHostBridge().shareAudio;
  const [sinks, setSinks] = useState<ShareSink[] | null>(null);
  useEffect(() => {
    if (shareAudio === undefined) return;
    let over = false;
    let reported = false;
    const refresh = (): void => {
      void shareAudio.listSinks().then(({ supported, sinks }) => {
        if (over) return;
        setSinks(supported ? sinks : null);
        if (!reported) {
          reported = true;
          diag("share_audio_sinks", { supported, count: sinks.length });
        }
      });
    };
    refresh();
    const timer = setInterval(refresh, 4000);
    return (): void => {
      over = true;
      clearInterval(timer);
    };
  }, [shareAudio]);
  return sinks;
}

/** The capture devices a share's audio can come from, under their names. */
export function useShareDevices(): {
  shareInputs: NamedDevice[];
  audioInputs: NamedDevice[];
} {
  const { t } = useTranslation();
  const devices = useMediaDevices();
  const audioInputs = useBehavior(devices.audioInput.available$);
  const shareInputs = useBehavior(devices.shareAudioSources$ ?? noDevices);
  return useMemo(() => {
    const named = (list: Map<string, DeviceLabel>): NamedDevice[] =>
      [...list].map(([id, label], i) => ({
        id,
        label:
          label.type === "name"
            ? label.name
            : t("settings.devices.microphone_numbered", { n: i + 1 }),
      }));
    return { shareInputs: named(shareInputs), audioInputs: named(audioInputs) };
  }, [audioInputs, shareInputs, t]);
}

/**
 * Where a screen share's sound comes from: nowhere, the screen picker, or a
 * mix of any number of sources, each with a gain and a mute of its own. The
 * sources are listed in groups: the outputs the host can make a capture
 * device of (with what is playing into each), the inputs set up to carry an
 * output's sound, and the other audio inputs. Every choice is kept for the
 * next share, and applies at once to the share that is on. The list does
 * not scroll by itself: whatever holds it does.
 */
export const ShareAudioSources: FC<Props> = ({ live }) => {
  const { t } = useTranslation();
  const searchId = useId();
  const [choice, setChoice] = useSetting(screenShareAudioSource);
  const [storedMix, setStoredMix] = useSetting(screenShareAudioMix);
  const status = useBehavior(shareAudioMixStatus$);
  const sinks = useShareSinks();
  const { shareInputs, audioInputs } = useShareDevices();
  const [query, setQuery] = useState("");

  const mode = shareAudioMode(choice);
  // What an older version stored as the one device is a mix of one. The mix
  // is kept while the mode is another, to come back to
  const legacy = mode === "mix" && choice !== "mix";
  const mix = legacy ? shareAudioMix(choice, []) : sanitizeMix(storedMix);
  useEffect(() => {
    if (shareAudioMode(choice) === "mix" && choice !== "mix") {
      setStoredMix(shareAudioMix(choice, []));
      setChoice("mix");
    }
  }, [choice, setChoice, setStoredMix]);

  const setMode = (value: ShareAudioMode): void => {
    diag("share_audio_choice", { mode: value, live });
    setChoice(value);
  };
  const setMix = (next: ShareAudioMixSource[]): void => {
    setStoredMix(next);
    // Picking a source is choosing the mix
    if (choice !== "mix") setChoice("mix");
  };
  const toggle = (sourceId: string, on: boolean): void => {
    const sink = sinkOfChoice(sourceId);
    diag("share_audio_choice", {
      kind: sink !== undefined ? "sink" : "device",
      sink,
      selected: on,
      live,
    });
    setMix(toggleShareSource(mix, sourceId, on));
  };
  const update = (
    sourceId: string,
    change: Partial<ShareAudioMixSource>,
  ): void =>
    setMix(mix.map((s) => (s.id === sourceId ? { ...s, ...change } : s)));

  const groups = shareSourceGroups({
    sinks,
    shareInputs,
    audioInputs,
    mix,
    unavailableLabel: t("screen_share_options.audio_unavailable"),
  });
  const shown = searchShareSources(groups, query);
  const counts = shareSourceCounts(groups);

  const echo =
    mode === "mix" &&
    (sinks ?? []).some(
      (sink) =>
        sink.ownPlayback && mix.some((s) => s.id === sinkChoice(sink.name)),
    );
  const failed = live && mix.some((s) => status[s.id] === "failed");
  const hint = echo
    ? t("screen_share_options.audio_sink_echo_warning")
    : failed
      ? t("screen_share_options.audio_source_failed")
      : mode === "system"
        ? live
          ? t("screen_share_options.audio_system_live_hint")
          : t("screen_share_options.audio_system_hint")
        : mode === "mix"
          ? t("screen_share_options.audio_mix_hint")
          : t("screen_share_options.audio_none_hint");

  const modeLabels: Record<ShareAudioMode, string> = {
    none: t("screen_share_options.audio_none"),
    system: t("screen_share_options.audio_system"),
    mix: t("screen_share_options.audio_mix"),
  };
  const groupLabels: Record<ShareSourceGroupId, string> = {
    outputs: t("screen_share_options.audio_sinks"),
    "share-inputs": t("screen_share_options.audio_share_sources"),
    inputs: t("screen_share_options.audio_inputs"),
    gone: t("screen_share_options.audio_gone"),
  };
  // The picker's audio belongs to the capture: it cannot be added to or
  // taken from a share that is on
  const modeDisabled = (value: ShareAudioMode): boolean =>
    live && (mode === "system" ? value !== "system" : value === "system");

  return (
    <div className={styles.shareAudio} data-testid="screenshare_audio">
      <div
        role="radiogroup"
        aria-label={t("screen_share_options.audio")}
        className={styles.modes}
        data-testid="screenshare_audio_source"
        data-value={mode}
      >
        {shareAudioModes(sharePlatform(navigator.userAgent)).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            disabled={modeDisabled(value)}
            onClick={() => setMode(value)}
            data-testid={`screenshare_audio_mode_${value}`}
          >
            {modeLabels[value]}
          </button>
        ))}
      </div>
      <p
        className={styles.hint}
        data-warning={echo || failed}
        data-testid="screenshare_audio_hint"
      >
        {hint}
      </p>
      {mode === "mix" && (
        <div className={styles.sources} data-testid="screenshare_audio_sources">
          <div className={styles.toolbar}>
            <label className={styles.search} htmlFor={searchId}>
              <SearchIcon aria-hidden width={16} height={16} />
              <input
                id={searchId}
                type="search"
                value={query}
                placeholder={t("screen_share_options.audio_search")}
                aria-label={t("screen_share_options.audio_search")}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <span
              className={styles.count}
              data-testid="screenshare_audio_count"
            >
              {t("screen_share_options.audio_count", counts)}
            </span>
            <button
              type="button"
              className={styles.link}
              onClick={() => setMix(selectAllShareSources(mix, shown))}
            >
              {t("screen_share_options.audio_select_all")}
            </button>
            <button
              type="button"
              className={styles.link}
              onClick={() => setMix(selectNoShareSources(mix, shown))}
            >
              {t("screen_share_options.audio_select_none")}
            </button>
          </div>
          {shown.length === 0 && (
            <p className={styles.empty}>
              {groups.length === 0
                ? t("screen_share_options.audio_no_sources")
                : t("screen_share_options.audio_no_match")}
            </p>
          )}
          {shown.map((group) => (
            <fieldset
              key={group.id}
              className={styles.group}
              data-testid={`screenshare_audio_group_${group.id}`}
            >
              <legend>{groupLabels[group.id]}</legend>
              {group.rows.map((row) => {
                const Icon = row.muted ? VolumeOffSolidIcon : VolumeOnSolidIcon;
                return (
                  <div
                    key={row.id}
                    className={styles.source}
                    data-selected={row.selected}
                    data-status={
                      live && row.selected ? status[row.id] : undefined
                    }
                  >
                    <label className={styles.name}>
                      <input
                        type="checkbox"
                        checked={row.selected}
                        onChange={(e) => toggle(row.id, e.target.checked)}
                      />
                      <span className={styles.text}>
                        <span className={styles.title}>
                          {row.label}
                          {row.ownPlayback &&
                            ` (${t("screen_share_options.audio_sink_own")})`}
                        </span>
                        {row.apps.length > 0 && (
                          <span className={styles.apps}>
                            {row.apps.join(", ")}
                          </span>
                        )}
                      </span>
                    </label>
                    {row.selected && (
                      <div className={styles.gain}>
                        <button
                          type="button"
                          aria-label={t(
                            "screen_share_options.audio_source_mute",
                            { source: row.label },
                          )}
                          aria-pressed={row.muted}
                          onClick={() => update(row.id, { muted: !row.muted })}
                        >
                          <Icon aria-hidden width={20} height={20} />
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={200}
                          step={1}
                          value={row.percent}
                          aria-label={t(
                            "screen_share_options.audio_source_gain",
                            { source: row.label },
                          )}
                          onChange={(e) =>
                            update(row.id, {
                              gain: Number(e.target.value) / 100,
                            })
                          }
                        />
                        <span className={styles.percent}>{row.percent}%</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>
      )}
    </div>
  );
};
