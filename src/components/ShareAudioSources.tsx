/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type FC, type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
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
  sinkLabel,
  sinkOfChoice,
} from "../state/shareAudioSink";
import { shareAudioMixStatus$ } from "../state/shareAudioMixer";
import { diag } from "../diagnostics/diag";
import { type DeviceLabel } from "../state/MediaDevices";
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

interface Row {
  id: string;
  label: string;
  note?: string;
}

/**
 * Where a screen share's sound comes from: nowhere, the screen picker, or a
 * mix of any number of sources, each with a gain and a mute of its own. The
 * sources are the outputs the host can make a capture device of (with what
 * is playing into each), the inputs set up to carry an output's sound, and
 * the other audio inputs. Every choice is kept for the next share, and
 * applies at once to the share that is on.
 */
export const ShareAudioSources: FC<Props> = ({ live }) => {
  const { t } = useTranslation();
  const id = useId();
  const [choice, setChoice] = useSetting(screenShareAudioSource);
  const [storedMix, setStoredMix] = useSetting(screenShareAudioMix);
  const devices = useMediaDevices();
  const audioInputs = useBehavior(devices.audioInput.available$);
  const shareInputs = useBehavior(devices.shareAudioSources$ ?? noDevices);
  const status = useBehavior(shareAudioMixStatus$);
  const shareAudio = useHostBridge().shareAudio;

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

  // The outputs the host can make a share's audio of, with what is playing
  // into each: asked again every few seconds, as that changes
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
    setMix(
      on
        ? [...mix, { id: sourceId, gain: 1, muted: false }]
        : mix.filter((s) => s.id !== sourceId),
    );
  };
  const update = (
    sourceId: string,
    change: Partial<ShareAudioMixSource>,
  ): void =>
    setMix(mix.map((s) => (s.id === sourceId ? { ...s, ...change } : s)));

  const deviceName = (label: DeviceLabel, n: number): string =>
    label.type === "name"
      ? label.name
      : t("settings.devices.microphone_numbered", { n });

  const sinkRows: Row[] = (sinks ?? []).map((sink) => ({
    id: sinkChoice(sink.name),
    label: sinkLabel(sink),
    note: sink.ownPlayback
      ? t("screen_share_options.audio_sink_own")
      : undefined,
  }));
  // An input that carries the sound of a listed output is that output
  const sinkSources = new Set((sinks ?? []).map((sink) => sink.source));
  const shareRows: Row[] = [...shareInputs]
    .filter(
      ([, label]) => !(label.type === "name" && sinkSources.has(label.name)),
    )
    .map(([deviceId, label], i) => ({
      id: deviceId,
      label: deviceName(label, i + 1),
    }));
  const inputRows: Row[] = [...audioInputs]
    // The default device is one of the others under another name
    .filter(([deviceId]) => deviceId !== "" && deviceId !== "default")
    .map(([deviceId, label], i) => ({
      id: deviceId,
      label: deviceName(label, i + 1),
    }));
  const known = new Set(
    [...sinkRows, ...shareRows, ...inputRows].map((row) => row.id),
  );
  // What was picked and is not there now stays listed, so it can be dropped
  const goneRows: Row[] = mix
    .filter((s) => !known.has(s.id))
    .map((s) => ({
      id: s.id,
      label: sinkOfChoice(s.id) ?? t("screen_share_options.audio_unavailable"),
    }));

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
        : t("screen_share_options.audio_mix_hint");

  const group = (label: string, rows: Row[], testId?: string): ReactNode =>
    rows.length > 0 && (
      <fieldset className={styles.group} data-testid={testId}>
        <legend>{label}</legend>
        {rows.map((row) => {
          const source = mix.find((s) => s.id === row.id);
          const percent = Math.round((source?.gain ?? 1) * 100);
          const Icon = source?.muted ? VolumeOffSolidIcon : VolumeOnSolidIcon;
          return (
            <div
              key={row.id}
              className={styles.source}
              data-status={live && source ? status[row.id] : undefined}
            >
              <label className={styles.name}>
                <input
                  type="checkbox"
                  checked={source !== undefined}
                  onChange={(e) => toggle(row.id, e.target.checked)}
                />
                <span>
                  {row.label}
                  {row.note && ` (${row.note})`}
                </span>
              </label>
              {source && (
                <div className={styles.gain}>
                  <button
                    type="button"
                    aria-label={t("screen_share_options.audio_source_mute", {
                      source: row.label,
                    })}
                    aria-pressed={source.muted}
                    onClick={() => update(row.id, { muted: !source.muted })}
                  >
                    <Icon aria-hidden width={20} height={20} />
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={percent}
                    aria-label={t("screen_share_options.audio_source_gain", {
                      source: row.label,
                    })}
                    onChange={(e) =>
                      update(row.id, { gain: Number(e.target.value) / 100 })
                    }
                  />
                  <span className={styles.percent}>{percent}%</span>
                </div>
              )}
            </div>
          );
        })}
      </fieldset>
    );

  return (
    <div className={styles.shareAudio} data-testid="screenshare_audio">
      <label htmlFor={id} className={styles.label}>
        {t("screen_share_options.audio")}
      </label>
      <select
        id={id}
        value={mode}
        // The picker's audio belongs to the capture: it cannot be added to
        // or taken from a share that is on
        disabled={live && mode === "system"}
        onChange={(e) => setMode(e.target.value as ShareAudioMode)}
        data-testid="screenshare_audio_source"
      >
        <option value="none">{t("screen_share_options.audio_none")}</option>
        <option value="system" disabled={live && mode !== "system"}>
          {t("screen_share_options.audio_system")}
        </option>
        <option value="mix">{t("screen_share_options.audio_mix")}</option>
      </select>
      <p
        className={styles.hint}
        data-warning={echo || failed}
        data-testid="screenshare_audio_hint"
      >
        {hint}
      </p>
      {mode !== "system" && (
        <div
          className={styles.sources}
          data-inactive={mode !== "mix"}
          data-testid="screenshare_audio_sources"
        >
          {group(
            t("screen_share_options.audio_sinks"),
            sinkRows,
            "screenshare_audio_sinks",
          )}
          {group(t("screen_share_options.audio_share_sources"), shareRows)}
          {group(t("screen_share_options.audio_inputs"), inputRows)}
          {group(t("screen_share_options.audio_gone"), goneRows)}
        </div>
      )}
    </div>
  );
};
