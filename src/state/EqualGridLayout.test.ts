/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { arrangeEqualGrid } from "./EqualGridLayout";

describe("arrangeEqualGrid", () => {
  it.each([
    // count, columns, rows in a 16:9 area
    [1, 1, 1],
    [2, 2, 1],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
    [7, 3, 3],
    [9, 3, 3],
    [10, 4, 3],
    [12, 4, 3],
    [16, 4, 4],
    [25, 5, 5],
  ])(
    "puts %i tiles in %i columns and %i rows of a 16:9 area",
    (count, columns, rows) => {
      const grid = arrangeEqualGrid(1920, 1080, count, 0);
      expect([grid.columns, grid.rows]).toEqual([columns, rows]);
    },
  );

  it("fills the area with one tile, and a 16:9 area with a square number of them", () => {
    expect(arrangeEqualGrid(1920, 1080, 1, 0)).toEqual({
      columns: 1,
      rows: 1,
      tileWidth: 1920,
      tileHeight: 1080,
    });
    expect(arrangeEqualGrid(1920, 1080, 4, 0)).toMatchObject({
      tileWidth: 960,
      tileHeight: 540,
    });
  });

  it("stacks tiles in a tall area and lines them up in a wide one", () => {
    expect(arrangeEqualGrid(500, 1600, 3)).toMatchObject({
      columns: 1,
      rows: 3,
    });
    expect(arrangeEqualGrid(3000, 500, 3)).toMatchObject({
      columns: 3,
      rows: 1,
    });
    expect(arrangeEqualGrid(1000, 1000, 2)).toMatchObject({
      columns: 1,
      rows: 2,
    });
  });

  it("is limited by the height where the area is wider than the tiles", () => {
    const grid = arrangeEqualGrid(2000, 450, 1, 0);
    expect(grid).toMatchObject({ tileWidth: 800, tileHeight: 450 });
  });

  it("never lets the tiles and gaps outgrow the area, and keeps them 16:9", () => {
    for (const [width, height] of [
      [1920, 1080],
      [1280, 1024],
      [800, 1200],
      [2560, 600],
      [333, 777],
    ])
      for (let count = 1; count <= 30; count++) {
        const gap = 8;
        const { columns, rows, tileWidth, tileHeight } = arrangeEqualGrid(
          width,
          height,
          count,
          gap,
        );
        expect(columns * rows).toBeGreaterThanOrEqual(count);
        // No empty row
        expect(columns * (rows - 1)).toBeLessThan(count);
        expect(columns * tileWidth + (columns - 1) * gap).toBeLessThanOrEqual(
          width,
        );
        expect(rows * tileHeight + (rows - 1) * gap).toBeLessThanOrEqual(
          height,
        );
        expect(tileWidth / tileHeight).toBeGreaterThan(1.7);
        expect(tileWidth / tileHeight).toBeLessThan(1.85);
      }
  });

  it("is the best there is: no other number of columns gives larger tiles", () => {
    for (let count = 1; count <= 20; count++) {
      const best = arrangeEqualGrid(1700, 900, count);
      for (let columns = 1; columns <= count; columns++) {
        const rows = Math.ceil(count / columns);
        const other = Math.min(
          (1700 - 8 * (columns - 1)) / columns,
          ((900 - 8 * (rows - 1)) / rows) * (16 / 9),
        );
        expect(best.tileWidth).toBeGreaterThanOrEqual(Math.floor(other) - 1);
      }
    }
  });

  it("takes another tile shape", () => {
    expect(arrangeEqualGrid(1000, 1000, 4, 0, 1)).toEqual({
      columns: 2,
      rows: 2,
      tileWidth: 500,
      tileHeight: 500,
    });
  });

  it("has nothing to arrange without tiles or without room", () => {
    const nothing = { columns: 0, rows: 0, tileWidth: 0, tileHeight: 0 };
    expect(arrangeEqualGrid(1920, 1080, 0)).toEqual(nothing);
    expect(arrangeEqualGrid(0, 1080, 3)).toEqual(nothing);
    expect(arrangeEqualGrid(1920, NaN, 3)).toEqual(nothing);
    expect(arrangeEqualGrid(10, 10, 50).tileWidth).toBe(0);
  });
});
