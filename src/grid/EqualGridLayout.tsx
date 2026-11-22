/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type CSSProperties, type ReactNode, useMemo } from "react";

import { type EqualGridLayout as EqualGridLayoutModel } from "../state/layout-types.ts";
import { arrangeEqualGrid } from "../state/EqualGridLayout.ts";
import styles from "./EqualGridLayout.module.css";
import { type CallLayout } from "./CallLayout";
import { useUpdateLayout } from "./Grid";
import { useBehavior } from "../useBehavior";

/** Between the tiles, and between them and the edges of the window. */
const GAP = 8;

interface EqualGridCSSProperties extends CSSProperties {
  "--gap": string;
  "--width": string;
  "--height": string;
}

/**
 * An implementation of the "equal grid" layout: every member and every screen
 * share in a tile of the same size, as large as the window allows, all of
 * them on screen. Nothing scrolls and nothing is promoted.
 */
export const makeEqualGridLayout: CallLayout<EqualGridLayoutModel> = ({
  minBounds$,
}) => ({
  foreground: "fixed",

  fixed: function EqualGridLayoutFixed({ ref, model, Slot }): ReactNode {
    useUpdateLayout();
    const { width, height } = useBehavior(minBounds$);
    const count = model.shares.length + model.grid.length;
    const { columns, tileWidth, tileHeight } = useMemo(
      () => arrangeEqualGrid(width - 2 * GAP, height, count, GAP),
      [width, height, count],
    );

    return (
      <div
        ref={ref}
        className={styles.fixed}
        data-testid="equal_grid"
        data-columns={columns}
        style={
          {
            "--gap": `${GAP}px`,
            "--width": `${tileWidth}px`,
            "--height": `${tileHeight}px`,
            // No wider than its columns, so that the rows break where the
            // arrangement says they do
            maxInlineSize: columns * tileWidth + (columns - 1) * GAP + 2 * GAP,
          } as EqualGridCSSProperties
        }
      >
        {model.shares.map((share) => (
          <Slot
            key={share.id}
            className={styles.slot}
            id={share.id}
            model={share.vm}
          />
        ))}
        {model.grid.map((m) => (
          <Slot key={m.id} className={styles.slot} id={m.id} model={m} />
        ))}
      </div>
    );
  },

  // Nothing scrolls: every tile is in the fixed layer
  scrolling: function EqualGridLayoutScrolling({ ref }): ReactNode {
    useUpdateLayout();
    return <div ref={ref} />;
  },
});
