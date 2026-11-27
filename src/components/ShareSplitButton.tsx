/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type FC } from "react";
import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "@vector-im/compound-web";
import { ChevronUpIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";

import { ShareScreenButton } from "../button";
import styles from "./MediaMuteAndSwitchButton.module.css";

interface Props {
  sharing: boolean;
  size: "md" | "lg";
  className?: string;
  /** Starts a share with the last settings, or stops the one that is on. */
  onShare: () => void;
  /**
   * Opens the share's settings (its audio sources while it is on). Without
   * it there is only the share button.
   */
  onSettings?: () => void;
}

/**
 * The share button of the call's controls, in two parts like the microphone
 * and the camera: the button itself shares at once with what was used last,
 * the chevron beside it opens the settings.
 */
export const ShareSplitButton: FC<Props> = ({
  sharing,
  size,
  className,
  onShare,
  onSettings,
}) => {
  const { t } = useTranslation();
  const button = (
    <ShareScreenButton
      size={size}
      className={onSettings ? undefined : className}
      enabled={sharing}
      onClick={onShare}
      data-testid="incall_screenshare"
    />
  );
  if (onSettings === undefined) return button;
  const label = sharing
    ? t("screen_share_options.audio_live_button")
    : t("screen_share_options.settings_button");
  return (
    <div className={classNames(styles.container, className)}>
      {button}
      <Tooltip label={label}>
        <Button
          iconOnly
          className={styles.menuButton}
          Icon={ChevronUpIcon}
          kind="tertiary"
          size="lg"
          aria-label={label}
          onClick={onSettings}
          data-testid="incall_screenshare_settings"
        />
      </Tooltip>
    </div>
  );
};
