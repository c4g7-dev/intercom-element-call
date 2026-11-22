/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { constant } from "./Behavior.ts";
import {
  type EqualGridLayout,
  type EqualGridLayoutMedia,
  type EqualGridShareTile,
} from "./layout-types.ts";
import { type MediaViewModel } from "./media/MediaViewModel.ts";
import { type TileStore } from "./TileStore";
import { SpotlightTileViewModel } from "./TileViewModel.ts";

/** The share tiles made so far, so that a share keeps its tile across layouts. */
export type EqualGridShareTiles = WeakMap<MediaViewModel, EqualGridShareTile>;

/**
 * Produces the equal grid: one tile per member and one per screen share, all
 * of them on screen at once and none of them promoted.
 */
export function equalGridLayout(
  media: EqualGridLayoutMedia,
  prevTiles: TileStore,
  shareTiles: EqualGridShareTiles,
): [EqualGridLayout, TileStore] {
  // Every tile is visible, so none has to be moved up to be seen
  const update = prevTiles.from(Infinity);
  for (const mediaVm of media.grid) update.registerGridTile(mediaVm);
  const tiles = update.build();

  const shares = media.screenShares.map((share) => {
    let tile = shareTiles.get(share);
    if (tile === undefined) {
      tile = {
        id: `share:${share.id}`,
        vm: new SpotlightTileViewModel(
          constant([share]),
          constant(false),
          constant("solid"),
        ),
      };
      shareTiles.set(share, tile);
    }
    return tile;
  });

  return [{ type: "equal-grid", shares, grid: tiles.gridTiles }, tiles];
}

export interface EqualGridArrangement {
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

/**
 * The rows and columns that make `count` tiles of one size and shape as large
 * as an area allows, with a gap between them.
 * @param aspectRatio - the tiles' width over their height
 */
export function arrangeEqualGrid(
  width: number,
  height: number,
  count: number,
  gap = 8,
  aspectRatio = 16 / 9,
): EqualGridArrangement {
  if (count <= 0 || !(width > 0) || !(height > 0))
    return { columns: 0, rows: 0, tileWidth: 0, tileHeight: 0 };
  let best: EqualGridArrangement | undefined;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const tileWidth = Math.min(
      (width - gap * (columns - 1)) / columns,
      ((height - gap * (rows - 1)) / rows) * aspectRatio,
    );
    // Between two arrangements with tiles of one size, a wide area gets the
    // wider one (tiles side by side) and a tall area the taller one
    const margin = width >= height ? -0.5 : 0.5;
    if (best === undefined || tileWidth > best.tileWidth + margin)
      best = {
        columns,
        rows,
        tileWidth,
        tileHeight: tileWidth / aspectRatio,
      };
  }
  const tileWidth = Math.max(0, Math.floor(best!.tileWidth));
  return {
    columns: best!.columns,
    rows: best!.rows,
    tileWidth,
    tileHeight: Math.floor(tileWidth / aspectRatio),
  };
}
