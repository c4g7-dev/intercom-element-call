/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type ChangeEvent,
  type FC,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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
import { type ShareSink, useHostBridge } from "../HostBridge";
import {
  prepareSinkDevice,
  SHARE_DEVICE_LABEL_PREFIX,
  sinkChoice,
  sinkLabel,
  sinkOfChoice,
} from "../state/shareAudioSink";
import { describeError, diag } from "../diagnostics/diag";
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
  const shareAudio = useHostBridge().shareAudio;

  // The outputs whose sound the host can make a share's audio of, with what
  // is playing into each: asked again every few seconds, as that changes
  const [sinks, setSinks] = useState<ShareSink[] | null>(null);
  useEffect(() => {
    if (!open || shareAudio === undefined) return;
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
  }, [open, shareAudio]);

  // A chosen output is made into a device right away, so that the share
  // starts without a wait and a failure shows here rather than as silence
  const sink = sinkOfChoice(audio);
  const sinksSupported = sinks !== null;
  const [sinkState, setSinkState] = useState<"preparing" | "ready" | "failed">(
    "preparing",
  );
  const preparedInDialog = useRef(false);
  useEffect(() => {
    if (!open || sink === undefined || shareAudio === undefined) return;
    if (!sinksSupported) return;
    let over = false;
    setSinkState("preparing");
    preparedInDialog.current = true;
    prepareSinkDevice(shareAudio, sink).then(
      () => {
        diag("share_audio_choice", { sink, ok: true });
        if (!over) setSinkState("ready");
      },
      (e: unknown) => {
        diag("share_audio_choice", {
          sink,
          ok: false,
          error: describeError(e),
        });
        if (!over) setSinkState("failed");
      },
    );
    return (): void => {
      over = true;
    };
  }, [open, sink, shareAudio, sinksSupported]);
  // Closed without sharing: nothing is listening to the device
  const dismiss = useCallback(() => {
    if (preparedInDialog.current) {
      preparedInDialog.current = false;
      void shareAudio?.releaseShareSource();
    }
    onDismiss();
  }, [onDismiss, shareAudio]);
  const chooseAudio = (choice: string): void => {
    // Away from an output: its device is of no more use
    if (preparedInDialog.current && sinkOfChoice(choice) === undefined) {
      preparedInDialog.current = false;
      void shareAudio?.releaseShareSource();
    }
    diag("share_audio_choice", {
      kind:
        sinkOfChoice(choice) !== undefined
          ? "sink"
          : ["none", "system"].includes(choice)
            ? choice
            : "device",
    });
    setAudio(choice);
  };
  const chosenSink = sinks?.find((s) => s.name === sink);
  const audioHint =
    sink === undefined || sinks === null
      ? t("screen_share_options.audio_hint")
      : chosenSink?.ownPlayback
        ? t("screen_share_options.audio_sink_echo_warning")
        : sinkState === "failed"
          ? t("screen_share_options.audio_sink_failed")
          : t("screen_share_options.audio_sink_hint");
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
    audio === "none" ||
    audio === "system" ||
    (sink !== undefined ? chosenSink !== undefined : audioInputs.has(audio));

  const inputOptions = [...audioInputs]
    // The devices the host makes of outputs are offered as the outputs
    .filter(
      ([, label]) =>
        !(
          label.type === "name" &&
          label.name.startsWith(SHARE_DEVICE_LABEL_PREFIX)
        ),
    )
    .map(([deviceId, label]) => (
      <option key={deviceId} value={deviceId}>
        {label.type === "name"
          ? label.name
          : t("settings.devices.microphone_numbered", {
              n: label.number,
            })}
      </option>
    ));

  return (
    <Modal
      title={t("screen_share_options.title")}
      open={open}
      onDismiss={dismiss}
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
          hint={audioHint}
          warning={
            sink !== undefined &&
            sinks !== null &&
            (chosenSink?.ownPlayback === true || sinkState === "failed")
          }
        >
          {(id) => (
            <select
              id={id}
              value={audio}
              onChange={(e) => chooseAudio(e.target.value)}
              data-testid="screenshare_audio_source"
            >
              <option value="none">
                {t("screen_share_options.audio_none")}
              </option>
              <option value="system">
                {t("screen_share_options.audio_system")}
              </option>
              {sinks !== null && sinks.length > 0 && (
                <optgroup
                  label={t("screen_share_options.audio_sinks")}
                  data-testid="screenshare_audio_sinks"
                >
                  {sinks.map((s) => (
                    <option key={s.name} value={sinkChoice(s.name)}>
                      {sinkLabel(s)}
                      {s.ownPlayback
                        ? ` (${t("screen_share_options.audio_sink_own")})`
                        : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {inputOptions.length > 0 && (
                <optgroup label={t("screen_share_options.audio_inputs")}>
                  {inputOptions}
                </optgroup>
              )}
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
          <Button kind="secondary" size="md" onClick={dismiss}>
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
