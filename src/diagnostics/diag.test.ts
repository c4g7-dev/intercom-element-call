/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  diag,
  diagBuffer,
  diagOutput,
  DIAG_PREFIX,
  resetDiag,
  sanitize,
} from "./diag";

describe("diag", () => {
  const log = vi.fn<(line: string) => void>();
  const write = diagOutput.write;
  beforeEach(() => {
    resetDiag();
    log.mockClear();
    diagOutput.write = log;
  });
  afterEach(() => {
    diagOutput.write = write;
    vi.restoreAllMocks();
  });

  it("writes one line of JSON behind the prefix and keeps the record", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    diag("mute", { source: "microphone", enabled: false, reason: "user" });
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0];
    expect(line.startsWith(DIAG_PREFIX)).toBe(true);
    expect(line).not.toContain("\n");
    const record = JSON.parse(line.slice(DIAG_PREFIX.length));
    expect(record).toEqual({
      v: 1,
      t: 1234,
      seq: 0,
      type: "mute",
      source: "microphone",
      enabled: false,
      reason: "user",
    });
    expect(diagBuffer()).toEqual([record]);
  });

  it("keeps a bounded number of records", () => {
    for (let i = 0; i < 3100; i++) diag("tick");
    expect(diagBuffer()).toHaveLength(3000);
    expect(diagBuffer()[0].seq).toBe(100);
  });

  it("never throws, whatever it is given", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => diag("odd", circular)).not.toThrow();
    expect(() => diag("odd", { big: 10n, fn: () => 1 })).not.toThrow();
  });
});

describe("sanitize", () => {
  it("drops whatever is named like a secret, at any depth", () => {
    expect(
      sanitize({
        source: "camera",
        token: "abc",
        accessToken: "abc",
        nested: { password: "x", e2eeKey: "y", keys: [1], keyFrames: 3 },
      }),
    ).toEqual({ source: "camera", nested: { keyFrames: 3 } });
  });

  it("cuts strings long enough to be content, and flattens errors", () => {
    const cut = sanitize("x".repeat(1000)) as string;
    expect(cut).toHaveLength(301);
    expect(sanitize({ e: new TypeError("boom") })).toEqual({
      e: { name: "TypeError", message: "boom" },
    });
  });

  it("keeps numbers JSON can carry", () => {
    expect(sanitize({ a: NaN, b: Infinity, c: 1.5 })).toEqual({
      a: "NaN",
      b: "Infinity",
      c: 1.5,
    });
  });
});
