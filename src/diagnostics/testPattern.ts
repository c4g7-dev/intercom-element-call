/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { POPOUT_WINDOW_NAME_PREFIX } from "../tile/popout";
import { diag } from "./diag";

export const TEST_PATTERN_WINDOW_NAME = `${POPOUT_WINDOW_NAME_PREFIX}testpattern`;

export const TEST_PATTERN_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24];
const FONTS: [name: string, family: string][] = [
  ["sans", "system-ui, 'Noto Sans', Arial, sans-serif"],
  ["serif", "'Noto Serif', 'DejaVu Serif', Georgia, serif"],
  ["mono", "'JetBrains Mono', 'DejaVu Sans Mono', Consolas, monospace"],
];
const SAMPLE =
  "Sphinx of black quartz, judge my vow — 0O 1lI 5S 8B rn/m {}[]() 0123456789";
const COLOURS: [text: string, background: string][] = [
  ["#ff0000", "#00ff00"],
  ["#0000ff", "#ff0000"],
  ["#00ff00", "#ff00ff"],
  ["#ffff00", "#0000ff"],
  ["#ff00ff", "#00ffff"],
  ["#d00000", "#000000"],
  ["#0050ff", "#000000"],
  ["#808080", "#8c8c8c"],
];

const STYLE = `
  html, body { margin: 0; background: #fff; color: #000; }
  body { padding: 12px 16px; font: 13px/1.3 system-ui, sans-serif; overflow: auto; }
  h1 { margin: 0 0 8px; font-size: 16px; }
  h2 { margin: 12px 0 4px; font-size: 12px; font-weight: 600; }
  .label { font: 14px/1.4 monospace; padding: 2px 6px; background: #000; color: #fff;
    display: inline-block; }
  .line { white-space: nowrap; overflow: hidden; margin: 0; }
  .dark { background: #000; color: #fff; padding: 2px 4px; }
  .colours { display: flex; flex-wrap: wrap; gap: 4px; }
  .colours span { padding: 2px 6px; font-size: 12px; }
  canvas { display: block; image-rendering: pixelated; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
`;

let current: Window | null = null;

/**
 * Opens a window with a static, high-contrast chart to share: text in
 * several fonts and sizes, one-pixel line pairs, a checkerboard and coloured
 * text on coloured backgrounds. What a viewer can still read of it is how
 * sharp the screen share is.
 *
 * @returns Whether there is a window now: false where the popup was blocked.
 */
export function openTestPattern(): boolean {
  if (current !== null && !current.closed) {
    current.focus();
    return true;
  }
  const win = window.open(
    "",
    TEST_PATTERN_WINDOW_NAME,
    "popup,width=1280,height=720",
  );
  if (win === null) {
    diag("test_pattern", { action: "blocked" });
    return false;
  }
  current = win;
  const doc = win.document;
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  doc.title = "InterCom sharpness test pattern";
  const style = doc.createElement("style");
  style.textContent = STYLE;
  doc.head.append(style);
  buildTestPattern(doc, win);
  diag("test_pattern", {
    action: "open",
    width: Math.round(win.innerWidth * win.devicePixelRatio),
    height: Math.round(win.innerHeight * win.devicePixelRatio),
    devicePixelRatio: win.devicePixelRatio,
  });
  win.addEventListener("pagehide", () => {
    if (current === win) current = null;
    diag("test_pattern", { action: "close" });
  });
  return true;
}

/** Fills a document with the chart; apart for the tests. */
export function buildTestPattern(doc: Document, win: Window): void {
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
    className?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className !== undefined) node.className = className;
    return node;
  };

  doc.body.append(el("h1", "InterCom sharpness test pattern"));
  const label = el("div", "", "label");
  label.id = "resolution";
  const describeSize = (): void => {
    const dpr = win.devicePixelRatio || 1;
    label.textContent = `window ${Math.round(win.innerWidth * dpr)} x ${Math.round(win.innerHeight * dpr)} device px  |  scale ${dpr}  |  screen ${Math.round(win.screen.width * dpr)} x ${Math.round(win.screen.height * dpr)}`;
  };
  describeSize();
  win.addEventListener("resize", describeSize);
  doc.body.append(label);

  doc.body.append(
    el("h2", "1 px and 2 px line pairs, checkerboards (device pixels)"),
  );
  const row = el("div", undefined, "row");
  row.append(
    patternCanvas(doc, win, "vertical-1", (x) => x % 2 === 0),
    patternCanvas(doc, win, "horizontal-1", (_x, y) => y % 2 === 0),
    patternCanvas(doc, win, "checker-1", (x, y) => (x + y) % 2 === 0),
    patternCanvas(doc, win, "vertical-2", (x) => (x >> 1) % 2 === 0),
    patternCanvas(
      doc,
      win,
      "checker-2",
      (x, y) => ((x >> 1) + (y >> 1)) % 2 === 0,
    ),
    patternCanvas(
      doc,
      win,
      "checker-4",
      (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0,
    ),
  );
  doc.body.append(row);

  doc.body.append(el("h2", "Colour on colour"));
  const colours = el("div", undefined, "colours");
  for (const [text, background] of COLOURS) {
    const swatch = el("span", `${text} on ${background} Abc 123`);
    swatch.style.color = text;
    swatch.style.background = background;
    colours.append(swatch);
  }
  doc.body.append(colours);

  for (const [name, family] of FONTS) {
    doc.body.append(el("h2", `${name}, black on white`));
    for (const size of TEST_PATTERN_SIZES) {
      const line = el("p", `${size} px  ${SAMPLE}`, "line");
      line.style.font = `${size}px/1.25 ${family}`;
      doc.body.append(line);
    }
  }
  doc.body.append(el("h2", "sans, white on black"));
  for (const size of TEST_PATTERN_SIZES) {
    const line = el("p", `${size} px  ${SAMPLE}`, "line dark");
    line.style.font = `${size}px/1.25 ${FONTS[0][1]}`;
    doc.body.append(line);
  }
}

/** A 96 by 64 device-pixel field, one canvas pixel per device pixel. */
function patternCanvas(
  doc: Document,
  win: Window,
  name: string,
  white: (x: number, y: number) => boolean,
): HTMLCanvasElement {
  const width = 96;
  const height = 64;
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.title = name;
  canvas.dataset.pattern = name;
  const dpr = win.devicePixelRatio || 1;
  canvas.style.width = `${width / dpr}px`;
  canvas.style.height = `${height / dpr}px`;
  const context = canvas.getContext("2d");
  if (context === null) return canvas;
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = white(x, y) ? 255 : 0;
      const i = (y * width + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
  context.putImageData(image, 0, 0);
  return canvas;
}
