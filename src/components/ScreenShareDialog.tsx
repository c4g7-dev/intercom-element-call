/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ChangeEvent, type FC, type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@vector-im/compound-web";

import { Modal } from "../Modal";
import {
  type ScreenSharePreset,
  type ScreenShareResolutionMode,
  screenShareAudioMix,
  screenShareAudioSource,
  screenShareCodecChoice,
  screenShareConfigured,
  screenShareCustomBitrate,
  screenShareCustomFramerate,
  screenSharePreset,
  screenShareResolutionMode,
  useSetting,
  type VideoCodec,
} from "../settings/settings";
import {
  DEFAULT_SCREEN_SHARE_CODEC,
  MAX_CUSTOM_BITRATE_MBPS,
} from "../state/screenShareOptions";
import { Config } from "../config/Config";
import {
  ShareAudioSources,
  useShareDevices,
  useShareSinks,
} from "./ShareAudioSources";
import {
  availableSourceIds,
  effectiveFramerate,
  FRAMERATE_CHOICES,
  shareAudioSummary,
  shareSourceGroups,
} from "../state/shareDialogModel";
import { shareAudioMix, shareAudioMode } from "../state/shareAudioSink";
import styles from "./ScreenShareDialog.module.css";

interface Props {
  open: boolean;
  onDismiss: () => void;
  /** Starts the share with the choices as they are now. */
  onShare: () => void;
}

const Field: FC<{
  label: string;
  hint?: string;
  /** Whether the hint is something to act on rather than an explanation. */
  warning?: boolean;
  children: (id: string) => ReactNode;
}> = ({ label, hint, warning, children }) => {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && (
        <p className={styles.hint} data-warning={warning === true}>
          {hint}
        </p>
      )}
    </div>
  );
};

const PRESETS: ScreenSharePreset[] = ["sharp", "motion", "low"];

/** What the share will be, in one line: for the dialog's foot. */
const Summary: FC = () => {
  const { t } = useTranslation();
  const [preset] = useSetting(screenSharePreset);
  const [resolution] = useSetting(screenShareResolutionMode);
  const [customFramerate] = useSetting(screenShareCustomFramerate);
  const [choice] = useSetting(screenShareAudioSource);
  const [storedMix] = useSetting(screenShareAudioMix);
  const sinks = useShareSinks();
  const { shareInputs, audioInputs } = useShareDevices();
  const mix = shareAudioMix(choice, storedMix);
  const audio = shareAudioSummary(
    shareAudioMode(choice),
    mix,
    availableSourceIds(
      shareSourceGroups({
        sinks,
        shareInputs,
        audioInputs,
        mix,
        unavailableLabel: "",
      }),
    ),
  );
  const presetLabels: Record<ScreenSharePreset, string> = {
    sharp: t("screen_share_options.preset_sharp"),
    motion: t("screen_share_options.preset_motion"),
    low: t("screen_share_options.preset_low"),
  };
  const resolutionLabels: Record<ScreenShareResolutionMode, string> = {
    auto: t("screen_share_options.resolution_auto_short"),
    native: t("screen_share_options.resolution_native_short"),
    "1440p": "1440p",
    "1080p": "1080p",
  };
  const parts = [
    presetLabels[preset],
    preset === "low" ? "720p" : resolutionLabels[resolution],
    t("screen_share_options.summary_fps", {
      fps: effectiveFramerate(preset, customFramerate),
    }),
    audio.kind === "mix"
      ? t("screen_share_options.summary_audio_mix", { count: audio.count })
      : audio.kind === "system"
        ? t("screen_share_options.summary_audio_system")
        : t("screen_share_options.summary_audio_none"),
  ];
  return (
    <p className={styles.summary} data-testid="screenshare_summary">
      {parts.join(" · ")}
    </p>
  );
};

/**
 * What a screen share is asked before it starts: what it is of (which decides
 * how it is encoded), how large and how often it is sent, and where its
 * sound comes from. Two columns where there is room for them, one scroll for
 * all of it where there is not. Every choice is kept for the next share,
 * which the share button then starts without asking.
 */
export const ScreenShareDialog: FC<Props> = ({ open, onDismiss, onShare }) => {
  const { t } = useTranslation();
  const [preset, setPreset] = useSetting(screenSharePreset);
  const [resolution, setResolution] = useSetting(screenShareResolutionMode);
  const [codec, setCodec] = useSetting(screenShareCodecChoice);
  const [customBitrate, setCustomBitrate] = useSetting(
    screenShareCustomBitrate,
  );
  const [customFramerate, setCustomFramerate] = useSetting(
    screenShareCustomFramerate,
  );
  const budget = Config.get().media_quality?.server_egress_budget_mbps ?? 0;

  const presets: Record<ScreenSharePreset, { label: string; hint: string }> = {
    sharp: {
      label: t("screen_share_options.preset_sharp"),
      hint: t("screen_share_options.preset_sharp_hint"),
    },
    motion: {
      label: t("screen_share_options.preset_motion"),
      hint: t("screen_share_options.preset_motion_hint"),
    },
    low: {
      label: t("screen_share_options.preset_low"),
      hint: t("screen_share_options.preset_low_hint"),
    },
  };
  const numberOf =
    (set: (value: number) => void, max: number) =>
    (e: ChangeEvent<HTMLInputElement>): void => {
      const value = Number(e.target.value);
      set(Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0);
    };
  const presetFramerate = effectiveFramerate(preset, 0);
  return (
    <Modal
      title={t("screen_share_options.title")}
      open={open}
      onDismiss={onDismiss}
      className={styles.dialog}
      classNameBody={styles.body}
    >
      <div className={styles.content} data-testid="screenshare_options">
        <div className={styles.columns}>
          <section className={styles.column}>
            <h3>{t("screen_share_options.preset")}</h3>
            <div
              role="radiogroup"
              aria-label={t("screen_share_options.preset")}
              className={styles.presets}
            >
              {PRESETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={preset === value}
                  className={styles.preset}
                  onClick={() => setPreset(value)}
                  data-testid={`screenshare_preset_${value}`}
                >
                  <span className={styles.presetLabel}>
                    {presets[value].label}
                  </span>
                  <span className={styles.presetHint}>
                    {presets[value].hint}
                  </span>
                </button>
              ))}
            </div>
            <div className={styles.pair}>
              <Field label={t("screen_share_options.resolution")}>
                {(id) => (
                  <select
                    id={id}
                    value={preset === "low" ? "low" : resolution}
                    disabled={preset === "low"}
                    onChange={(e) =>
                      setResolution(e.target.value as ScreenShareResolutionMode)
                    }
                  >
                    {preset === "low" && <option value="low">720p</option>}
                    <option value="auto">
                      {t("screen_share_options.resolution_auto")}
                    </option>
                    <option value="native">
                      {t("screen_share_options.resolution_native")}
                    </option>
                    <option value="1440p">1440p</option>
                    <option value="1080p">1080p</option>
                  </select>
                )}
              </Field>
              <Field label={t("screen_share_options.framerate")}>
                {(id) => (
                  <select
                    id={id}
                    value={
                      FRAMERATE_CHOICES.includes(customFramerate)
                        ? customFramerate
                        : "custom"
                    }
                    onChange={(e) => setCustomFramerate(Number(e.target.value))}
                  >
                    {FRAMERATE_CHOICES.map((fps) => (
                      <option key={fps} value={fps}>
                        {fps === 0
                          ? t("screen_share_options.framerate_auto", {
                              fps: presetFramerate,
                            })
                          : t("screen_share_options.summary_fps", { fps })}
                      </option>
                    ))}
                    {!FRAMERATE_CHOICES.includes(customFramerate) && (
                      <option value="custom" disabled>
                        {t("screen_share_options.summary_fps", {
                          fps: customFramerate,
                        })}
                      </option>
                    )}
                  </select>
                )}
              </Field>
            </div>
            <details className={styles.advanced}>
              <summary>{t("screen_share_options.advanced")}</summary>
              <Field
                label={t("screen_share_options.codec")}
                hint={t("screen_share_options.codec_hint")}
              >
                {(id) => (
                  <select
                    id={id}
                    value={codec}
                    onChange={(e) =>
                      setCodec(e.target.value as VideoCodec | "auto")
                    }
                  >
                    <option value="auto">
                      {t("screen_share_options.codec_auto", {
                        codec: DEFAULT_SCREEN_SHARE_CODEC.toUpperCase(),
                      })}
                    </option>
                    <option value="vp8">VP8</option>
                    <option value="h264">H.264</option>
                    <option value="vp9">VP9</option>
                    <option value="av1">AV1</option>
                  </select>
                )}
              </Field>
              <Field
                label={t("screen_share_options.custom_bitrate")}
                hint={
                  customBitrate > 0 && budget > 0
                    ? t("screen_share_options.custom_bitrate_warning", {
                        budget,
                      })
                    : t("screen_share_options.custom_hint")
                }
                warning={customBitrate > 0 && budget > 0}
              >
                {(id) => (
                  <input
                    id={id}
                    type="number"
                    min={0}
                    max={MAX_CUSTOM_BITRATE_MBPS}
                    step={1}
                    value={customBitrate}
                    data-warning={customBitrate > 0 && budget > 0}
                    onChange={numberOf(
                      setCustomBitrate,
                      MAX_CUSTOM_BITRATE_MBPS,
                    )}
                  />
                )}
              </Field>
              <Field label={t("screen_share_options.custom_framerate")}>
                {(id) => (
                  <input
                    id={id}
                    type="number"
                    min={0}
                    max={120}
                    step={1}
                    value={customFramerate}
                    onChange={numberOf(setCustomFramerate, 120)}
                  />
                )}
              </Field>
            </details>
          </section>
          <section className={styles.column}>
            <h3>{t("screen_share_options.audio")}</h3>
            <ShareAudioSources live={false} />
          </section>
        </div>
        <div className={styles.footer}>
          <Summary />
          <div className={styles.actions}>
            <Button kind="secondary" size="md" onClick={onDismiss}>
              {t("action.close")}
            </Button>
            <Button
              kind="primary"
              size="md"
              onClick={() => {
                // From now on the share button starts a share like this one
                screenShareConfigured.setValue(true);
                onShare();
              }}
              data-testid="screenshare_start"
            >
              {t("screenshare_button_label")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

/**
 * The sources of the audio of the share that is on, to add to, take from and
 * balance while it runs.
 */
export const ShareAudioDialog: FC<Pick<Props, "open" | "onDismiss">> = ({
  open,
  onDismiss,
}) => {
  const { t } = useTranslation();
  return (
    <Modal
      title={t("screen_share_options.audio_live_title")}
      open={open}
      onDismiss={onDismiss}
      className={styles.audioDialog}
      classNameBody={styles.body}
    >
      <div className={styles.content} data-testid="share_audio_live">
        <div className={styles.single}>
          <ShareAudioSources live={true} />
        </div>
        <div className={styles.footer}>
          <span />
          <div className={styles.actions}>
            <Button kind="primary" size="md" onClick={onDismiss}>
              {t("action.close")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};
