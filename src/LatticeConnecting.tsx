/*
Copyright 2026 The InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type FC } from "react";

import styles from "./LatticeConnecting.module.css";

/** The ring, clockwise from the top left: each dot lights up a little after the one before. */
const RING: Array<[number, number]> = [
  [156, 156],
  [256, 156],
  [356, 156],
  [356, 256],
  [356, 356],
  [256, 356],
  [156, 356],
  [156, 256],
];

interface Props {
  /** Width and height in pixels */
  size?: number;
}

/**
 * Lattice's mark while the call loads or is being joined (the drawing of the
 * icon set's lattice-connecting.svg). It is decoration: the words beside it
 * say what is going on. With reduced motion it stands still.
 */
export const LatticeConnecting: FC<Props> = ({ size = 72 }) => (
  <svg
    className={styles.mark}
    width={size}
    height={size}
    viewBox="0 0 512 512"
    aria-hidden
    data-testid="lattice-connecting"
  >
    <rect
      className={styles.tile}
      x="16"
      y="16"
      width="480"
      height="480"
      rx="112"
    />
    {RING.map(([cx, cy], i) => (
      <circle
        key={`${cx}-${cy}`}
        className={styles.ring}
        cx={cx}
        cy={cy}
        r="26"
        style={{ animationDelay: `${(i * 0.267).toFixed(2)}s` }}
      />
    ))}
    <circle className={styles.centre} cx="256" cy="256" r="34" />
  </svg>
);
