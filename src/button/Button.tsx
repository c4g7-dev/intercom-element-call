/*
Copyright 2022-2024 New Vector Ltd.
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/
import {
  type ComponentPropsWithoutRef,
  type FC,
  type ReactNode,
  type SVGAttributes,
  useId,
} from "react";
import classNames from "classnames";
import { useTranslation } from "react-i18next";
import {
  Button as CpdButton,
  IconButton,
  Tooltip,
} from "@vector-im/compound-web";
import {
  MicOnSolidIcon,
  MicOffSolidIcon,
  SpinnerIcon,
  VideoCallSolidIcon,
  VideoCallOffSolidIcon,
  EndCallIcon,
  ShareScreenSolidIcon,
  OverflowHorizontalIcon,
  OverflowVerticalIcon,
  VolumeOnSolidIcon,
  VolumeOffSolidIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import styles from "./Button.module.css";
import callFooterStyles from "../components/CallFooter.module.css";
import { platform } from "../Platform";
import { type DeviceUnavailability } from "../state/deviceAvailability";
import {
  MicUnavailableIcon,
  VideoUnavailableIcon,
} from "./DeviceUnavailableIcon";

interface MicButtonProps extends ComponentPropsWithoutRef<"button"> {
  enabled: boolean;
  busy?: boolean;
  size?: "md" | "lg";
  /** Why there is no microphone to turn on, if there is none. */
  unavailable?: DeviceUnavailability;
}

export const MicButton: FC<MicButtonProps> = ({
  enabled,
  busy,
  unavailable,
  ...props
}) => {
  const { t } = useTranslation();
  if (unavailable !== undefined)
    return (
      <UnavailableDeviceButton
        Icon={MicUnavailableIcon}
        name={t("settings.devices.microphone")}
        reason={
          unavailable === "no-device"
            ? t("settings.devices.no_microphone")
            : t("settings.devices.microphone_blocked")
        }
        unavailable={unavailable}
        {...props}
      />
    );
  const Icon = busy ? SpinnerIcon : enabled ? MicOnSolidIcon : MicOffSolidIcon;
  const label = enabled
    ? t("mute_microphone_button_label")
    : t("unmute_microphone_button_label");

  return (
    <Tooltip label={label}>
      <CpdButton
        iconOnly
        Icon={Icon}
        kind={enabled ? "secondary" : "primary"}
        role="switch"
        aria-checked={enabled}
        {...props}
        aria-busy={busy}
        className={classNames(props.className, {
          [styles.rotate]: !!busy,
        })}
        disabled={props.disabled || busy}
      />
    </Tooltip>
  );
};

interface VideoButtonProps extends ComponentPropsWithoutRef<"button"> {
  enabled: boolean;
  busy?: boolean;
  size?: "md" | "lg";
  /** Why there is no camera to turn on, if there is none. */
  unavailable?: DeviceUnavailability;
}

export const VideoButton: FC<VideoButtonProps> = ({
  enabled,
  busy,
  unavailable,
  ...props
}) => {
  const { t } = useTranslation();
  if (unavailable !== undefined)
    return (
      <UnavailableDeviceButton
        Icon={VideoUnavailableIcon}
        name={t("settings.devices.camera")}
        reason={
          unavailable === "no-device"
            ? t("settings.devices.no_camera")
            : t("settings.devices.camera_blocked")
        }
        unavailable={unavailable}
        {...props}
      />
    );
  const Icon = busy
    ? SpinnerIcon
    : enabled
      ? VideoCallSolidIcon
      : VideoCallOffSolidIcon;
  const label = enabled
    ? t("stop_video_button_label")
    : t("start_video_button_label");

  return (
    <Tooltip label={label}>
      <CpdButton
        iconOnly
        Icon={Icon}
        kind={enabled ? "secondary" : "primary"}
        role="switch"
        aria-checked={enabled}
        {...props}
        aria-busy={busy}
        className={classNames(props.className, {
          [styles.rotate]: !!busy,
        })}
        disabled={props.disabled || busy}
      />
    </Tooltip>
  );
};

interface UnavailableDeviceButtonProps extends ComponentPropsWithoutRef<"button"> {
  Icon: FC<SVGAttributes<SVGElement>>;
  /** The device, as the button's name */
  name: string;
  /** Why it cannot be turned on: the tooltip, and the button's description */
  reason: string;
  unavailable: DeviceUnavailability;
  size?: "md" | "lg";
}

/**
 * The microphone's or the camera's button where there is no device to turn
 * on: it can be focused, so that it says why, and does nothing.
 */
function UnavailableDeviceButton({
  Icon,
  name,
  reason,
  unavailable,
  ...props
}: UnavailableDeviceButtonProps): ReactNode {
  const reasonId = useId();
  return (
    <>
      <Tooltip description={reason}>
        <CpdButton
          iconOnly
          Icon={Icon}
          kind="secondary"
          role="switch"
          aria-checked={false}
          aria-label={name}
          data-unavailable={unavailable}
          {...props}
          // The tooltip describes it only while it is shown
          aria-describedby={reasonId}
          onClick={undefined}
          disabled
        />
      </Tooltip>
      <span id={reasonId} hidden>
        {reason}
      </span>
    </>
  );
}

interface ShareScreenButtonProps extends ComponentPropsWithoutRef<"button"> {
  enabled: boolean;
  size: "md" | "lg";
}

export const ShareScreenButton: FC<ShareScreenButtonProps> = ({
  enabled,
  ...props
}) => {
  const { t } = useTranslation();
  const label = enabled
    ? t("stop_screenshare_button_label")
    : t("screenshare_button_label");

  return (
    <Tooltip label={label}>
      <CpdButton
        iconOnly
        Icon={ShareScreenSolidIcon}
        kind={enabled ? "primary" : "secondary"}
        role="switch"
        aria-checked={enabled}
        {...props}
      />
    </Tooltip>
  );
};

interface EndCallButtonProps extends ComponentPropsWithoutRef<"button"> {
  size?: "md" | "lg";
}

export const EndCallButton: FC<EndCallButtonProps> = (props) => {
  const { t } = useTranslation();

  return (
    <Tooltip label={t("hangup_button_label")}>
      <CpdButton iconOnly Icon={EndCallIcon} destructive {...props} />
    </Tooltip>
  );
};

interface LoudspeakerButtonProps extends ComponentPropsWithoutRef<"button"> {
  size?: "md" | "lg";
  loudspeakerModeEnabled: boolean;
}
export const LoudspeakerButton: FC<LoudspeakerButtonProps> = ({
  loudspeakerModeEnabled,
  ...props
}) => {
  const { t } = useTranslation();
  // if the target is the earpice, we are currently in loudspeaker mode.
  const label = loudspeakerModeEnabled
    ? t("settings.devices.loudspeaker")
    : t("settings.devices.handset");
  return (
    <Tooltip label={label}>
      <CpdButton
        iconOnly
        Icon={loudspeakerModeEnabled ? VolumeOnSolidIcon : VolumeOffSolidIcon}
        {...props}
        kind={loudspeakerModeEnabled ? "secondary" : "primary"}
        aria-checked={loudspeakerModeEnabled}
      />
    </Tooltip>
  );
};

function classNamesForScreenWidth(
  className?: string,
  forScreenWidth?: "wide" | "narrow",
): string {
  return classNames(className, {
    [callFooterStyles.settingsOnlyShowWide]: forScreenWidth === "wide",
    [callFooterStyles.settingsOnlyShowNarrow]: forScreenWidth === "narrow",
  });
}

interface SettingsIconButtonProps extends ComponentPropsWithoutRef<"button"> {
  /** If this buttons should be setup to be used in the app bar */
  showForScreenWidth?: "wide" | "narrow";
  kind?: "secondary" | "primary";
}
export const SettingsIconButton: FC<SettingsIconButtonProps> = ({
  showForScreenWidth,
  className,
  ...props
}) => {
  const { t } = useTranslation();
  const Icon =
    platform === "android" ? OverflowVerticalIcon : OverflowHorizontalIcon;
  return (
    <Tooltip label={t("common.settings")}>
      <IconButton
        className={classNamesForScreenWidth(className, showForScreenWidth)}
        {...props}
      >
        <Icon aria-hidden />
      </IconButton>
    </Tooltip>
  );
};

interface SettingsButtonProps extends ComponentPropsWithoutRef<"button"> {
  size?: "md" | "lg";
  /** If this buttons should be setup to be used in the app bar */
  showForScreenWidth?: "wide" | "narrow";
}
export const SettingsButton: FC<SettingsButtonProps> = ({
  showForScreenWidth,
  className,
  ...props
}) => {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("common.settings")}>
      <CpdButton
        className={classNamesForScreenWidth(className, showForScreenWidth)}
        iconOnly
        Icon={
          platform === "android" ? OverflowVerticalIcon : OverflowHorizontalIcon
        }
        kind={"secondary"}
        {...props}
      />
    </Tooltip>
  );
};
