/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type FC, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import classNames from "classnames";

import styles from "./AloneBanner.module.css";
import { formatCountdown } from "../state/aloneTimer";

interface Props {
  /** When the call is left, in ms on the clock of `now` */
  deadline: number;
  /** Starts the countdown over */
  onStay: () => void;
  /** Leaves the call at once */
  onLeave: () => void;
  /** Whether something else is shown at the top of the call, to sit under */
  lowered?: boolean;
  /** The time, in ms */
  now?: () => number;
}

/**
 * Says that everybody else left a private call and when the user is taken
 * out of it, with the ways to stay or to leave at once (InterCom). A bar at
 * the top of the call, clear of its controls.
 */
export const AloneBanner: FC<Props> = ({
  deadline,
  onStay,
  onLeave,
  lowered = false,
  now = Date.now,
}) => {
  const { t } = useTranslation();
  const [msLeft, setMsLeft] = useState(() => deadline - now());
  useEffect(() => {
    const tick = (): void => setMsLeft(deadline - now());
    tick();
    const interval = setInterval(tick, 250);
    return (): void => clearInterval(interval);
  }, [deadline, now]);
  const time = formatCountdown(msLeft);

  return (
    <div
      className={classNames(styles.banner, { [styles.lowered]: lowered })}
      role="status"
      // The seconds are not read out one by one
      aria-live="off"
      data-testid="alone_banner"
    >
      <span className={styles.text}>
        {t("alone_in_call.alone")}
        <span className={styles.dot} aria-hidden>
          ·
        </span>
        <span className={styles.countdown}>
          {t("alone_in_call.disconnecting_in", { time })}
        </span>
      </span>
      <span className={styles.buttons}>
        {/* Smaller than the smallest of Compound's buttons, which would
            make a bar of the notice */}
        <button type="button" className={styles.stay} onClick={onStay}>
          {t("alone_in_call.stay")}
        </button>
        <button type="button" className={styles.leave} onClick={onLeave}>
          {t("alone_in_call.leave")}
        </button>
      </span>
    </div>
  );
};
