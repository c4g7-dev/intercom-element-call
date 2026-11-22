/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ChangeEvent, type FC, type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@vector-im/compound-web";

import { Modal } from "../Modal";
import { useMediaDevices } from "../MediaDevicesContext";
import { useBehavior } from "../useBehavior";
import {
  type ScreenSharePreset,
  type ScreenShareResolutionMode,
  screenShareAudioSource,
  screenShareCodecChoice,
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
  children: (id: string) => ReactNode;
}> = ({ label, hint, children }) => {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
};

/**
 * What a screen share is asked before it starts: what it is of (which decides
 * how it is encoded), how large it is sent and where its sound comes from.
 * Every choice is kept for the next share.
 */
export const ScreenShareDialog: FC<Props> = ({ open, onDismiss, onShare }) => {
  const { t } = useTranslation();
  const [preset, setPreset] = useSetting(screenSharePreset);
  const [resolution, setResolution] = useSetting(screenShareResolutionMode);
  const [codec, setCodec] = useSetting(screenShareCodecChoice);
  const [audio, setAudio] = useSetting(screenShareAudioSource);
  const [customBitrate, setCustomBitrate] = useSetting(
    screenShareCustomBitrate,
  );
  const [customFramerate, setCustomFramerate] = useSetting(
    screenShareCustomFramerate,
  );
  const audioInputs = useBehavior(useMediaDevices().audioInput.available$);
  const budget = Config.get().media_quality?.server_egress_budget_mbps ?? 0;

  const presetHints: Record<ScreenSharePreset, string> = {
    sharp: t("screen_share_options.preset_sharp_hint"),
    motion: t("screen_share_options.preset_motion_hint"),
    low: t("screen_share_options.preset_low_hint"),
  };
  const numberOf =
    (set: (value: number) => void, max: number) =>
    (e: ChangeEvent<HTMLInputElement>): void => {
      const value = Number(e.target.value);
      set(Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0);
    };
  // A device that has gone since it was picked is still shown, as what it was
  const audioKnown =
    audio === "none" || audio === "system" || audioInputs.has(audio);

  return (
    <Modal
      title={t("screen_share_options.title")}
      open={open}
      onDismiss={onDismiss}
      className={styles.dialog}
    >
      <div className={styles.content} data-testid="screenshare_options">
        <Field
          label={t("screen_share_options.preset")}
          hint={presetHints[preset]}
        >
          {(id) => (
            <select
              id={id}
              value={preset}
              onChange={(e) => setPreset(e.target.value as ScreenSharePreset)}
            >
              <option value="sharp">
                {t("screen_share_options.preset_sharp")}
              </option>
              <option value="motion">
                {t("screen_share_options.preset_motion")}
              </option>
              <option value="low">
                {t("screen_share_options.preset_low")}
              </option>
            </select>
          )}
        </Field>
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
        <Field
          label={t("screen_share_options.audio")}
          hint={t("screen_share_options.audio_hint")}
        >
          {(id) => (
            <select
              id={id}
              value={audio}
              onChange={(e) => setAudio(e.target.value)}
              data-testid="screenshare_audio_source"
            >
              <option value="none">
                {t("screen_share_options.audio_none")}
              </option>
              <option value="system">
                {t("screen_share_options.audio_system")}
              </option>
              {[...audioInputs].map(([deviceId, label]) => (
                <option key={deviceId} value={deviceId}>
                  {label.type === "name"
                    ? label.name
                    : t("settings.devices.microphone_numbered", {
                        n: label.number,
                      })}
                </option>
              ))}
              {!audioKnown && (
                <option value={audio}>
                  {t("screen_share_options.audio_unavailable")}
                </option>
              )}
            </select>
          )}
        </Field>
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
                ? t("screen_share_options.custom_bitrate_warning", { budget })
                : t("screen_share_options.custom_hint")
            }
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
                onChange={numberOf(setCustomBitrate, MAX_CUSTOM_BITRATE_MBPS)}
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
        <div className={styles.actions}>
          <Button kind="secondary" size="md" onClick={onDismiss}>
            {t("action.close")}
          </Button>
          <Button
            kind="primary"
            size="md"
            onClick={onShare}
            data-testid="screenshare_start"
          >
            {t("screenshare_button_label")}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
