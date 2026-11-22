/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type FC, useCallback } from "react";
import { useTranslation } from "react-i18next";

import styles from "./DiagnosticsOverlay.module.css";
import { useBehavior } from "../useBehavior";
import { useEventTarget } from "../useEvents";
import { useRootElement } from "../RootElementContext";
import {
  diagnosticsOverlay as diagnosticsOverlaySetting,
  useSetting,
} from "../settings/settings";
import { type DiagSample, diagSample$ } from "./CallDiagnostics";
import { type CheckId, type CheckResult } from "./checks";
import { diagBuffer, type DiagRecord } from "./diag";
import { openTestPattern } from "./testPattern";
import { type TrackRecord } from "./trackStats";

/**
 * The diagnostics overlay and its shortcut, Ctrl+Alt+D (Ctrl+Shift+D is
 * deafen). Draws nothing
 * while the overlay is off.
 */
export const DiagnosticsOverlay: FC = () => {
  const [shown, setShown] = useSetting(diagnosticsOverlaySetting);
  const rootElement = useRootElement();
  useEventTarget(
    rootElement,
    "keydown",
    useCallback(
      (event: KeyboardEvent) => {
        if (
          !event.ctrlKey ||
          !event.altKey ||
          event.shiftKey ||
          event.key.toLowerCase() !== "d"
        )
          return;
        event.preventDefault();
        setShown(!shown);
      },
      [shown, setShown],
    ),
  );
  if (!shown) return null;
  return <DiagnosticsPanel onClose={() => setShown(false)} />;
};

const DiagnosticsPanel: FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const sample = useBehavior(diagSample$);
  const checkLabels: Record<CheckId, string> = {
    mic_audio: t("diagnostics.check_mic_audio"),
    share_resolution: t("diagnostics.check_share_resolution"),
    share_audio: t("diagnostics.check_share_audio"),
    no_limitation: t("diagnostics.check_no_limitation"),
    top_layer: t("diagnostics.check_top_layer"),
  };
  return (
    <section
      className={styles.overlay}
      aria-label={t("diagnostics.title")}
      data-testid="diagnostics_overlay"
    >
      <header className={styles.header}>
        <strong>{t("diagnostics.title")}</strong>
        <span className={styles.summary}>{summary(sample)}</span>
        <button type="button" onClick={() => openTestPattern()}>
          {t("diagnostics.test_pattern")}
        </button>
        <button type="button" onClick={onClose}>
          {t("action.close")}
        </button>
      </header>
      {sample === null ? (
        <p className={styles.waiting}>{t("diagnostics.waiting")}</p>
      ) : (
        <>
          <ul className={styles.checks}>
            {sample.checks.map((check) => (
              <Check
                key={check.id}
                check={check}
                label={checkLabels[check.id]}
              />
            ))}
          </ul>
          <TrackTable tracks={sample.tracks} />
        </>
      )}
      <MuteTimeline />
    </section>
  );
};

function summary(sample: DiagSample | null): string {
  if (sample === null) return "";
  const budget = sample.share?.budget;
  return [
    sample.state,
    `${sample.viewers} remote`,
    budget &&
      `cap ${mbps(budget.maxBitrate)} @ ${budget.maxFramerate} fps (${budget.mbps} Mbps / ${budget.viewers})`,
  ]
    .filter(Boolean)
    .join(" · ");
}

const Check: FC<{ check: CheckResult; label: string }> = ({ check, label }) => (
  <li data-status={check.status} data-testid={`diagnostics_check_${check.id}`}>
    <span className={styles.mark} aria-hidden>
      {check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "–"}
    </span>
    <span>{label}</span>
    <span className={styles.detail}>{check.detail}</span>
  </li>
);

const TrackTable: FC<{ tracks: TrackRecord[] }> = ({ tracks }) => (
  <table className={styles.tracks}>
    <thead>
      <tr>
        <th>track</th>
        <th>res</th>
        <th>fps</th>
        <th>bitrate</th>
        <th>codec</th>
        <th>coder</th>
        <th>limit</th>
        <th>loss</th>
        <th>rtt</th>
        <th>level</th>
      </tr>
    </thead>
    <tbody>
      {[...tracks].sort(byDirectionAndSource).map((track) => (
        <tr key={track.sid} data-muted={track.muted}>
          <td title={track.participant}>
            {track.dir === "send" ? "↑" : "↓"} {track.source}
            {track.dir === "recv" && ` ${shortName(track.participant)}`}
            {track.muted && " (muted)"}
          </td>
          <td>
            {track.width !== undefined && `${track.width}x${track.height}`}
          </td>
          <td>{track.fps !== undefined && Math.round(track.fps)}</td>
          <td>
            {mbps(track.bitrate)}
            {track.targetBitrate !== undefined &&
              ` / ${mbps(track.targetBitrate)}`}
          </td>
          <td>
            {track.codec}
            {track.scalabilityMode && ` ${track.scalabilityMode}`}
          </td>
          <td title={track.impl} data-hw={String(track.hw)}>
            {track.kind === "video" &&
              (track.hw === null ? "?" : track.hw ? "HW" : "SW")}
          </td>
          <td data-limited={!!track.limitation && track.limitation !== "none"}>
            {track.limitation}
          </td>
          <td>{track.lossPct !== undefined && `${track.lossPct}%`}</td>
          <td>{track.rttMs !== undefined && `${Math.round(track.rttMs)}`}</td>
          <td>
            {track.kind === "audio" && <Meter level={track.audioLevel ?? 0} />}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

const Meter: FC<{ level: number }> = ({ level }) => (
  <span className={styles.meter} title={level.toFixed(3)}>
    <span
      style={{
        // Levels are linear; the square root spreads the quiet end out
        inlineSize: `${Math.min(100, Math.round(Math.sqrt(level) * 100))}%`,
      }}
    />
  </span>
);

const TIMELINE_TYPES = new Set([
  "mute",
  "mute_request",
  "track_muted",
  "publish_result",
  "participation",
  "screen_share_start",
  "screen_share_stop",
  "screen_share_error",
]);

const MuteTimeline: FC = () => {
  const events = diagBuffer()
    .filter((record) => TIMELINE_TYPES.has(record.type))
    .slice(-8);
  return (
    <ol className={styles.timeline}>
      {events.map((record) => (
        <li key={record.seq}>
          <time>{new Date(record.t).toLocaleTimeString()}</time>{" "}
          {describeEvent(record)}
        </li>
      ))}
    </ol>
  );
};

const EVENT_ENVELOPE = new Set(["v", "t", "seq", "type"]);

function describeEvent(record: DiagRecord): string {
  return `${record.type} ${Object.entries(record)
    .filter(
      ([key, value]) => !EVENT_ENVELOPE.has(key) && typeof value !== "object",
    )
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ")}`;
}

function byDirectionAndSource(a: TrackRecord, b: TrackRecord): number {
  return (
    a.dir.localeCompare(b.dir) * -4 +
    a.participant.localeCompare(b.participant) * 2 +
    a.source.localeCompare(b.source)
  );
}

function shortName(participant: string): string {
  return participant.split(":")[0].replace(/^@/, "").slice(0, 16);
}

function mbps(bitrate: number | undefined): string {
  if (bitrate === undefined) return "";
  return bitrate >= 1_000_000
    ? `${(bitrate / 1_000_000).toFixed(1)}M`
    : `${Math.round(bitrate / 1000)}k`;
}
