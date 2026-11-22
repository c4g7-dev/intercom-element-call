/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type VideoMediaTrack } from "@element-hq/matrixrtc-sdk";
import {
  type FC,
  type RefObject,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ExitFullScreenIcon,
  FullScreenIcon,
  PopOutIcon,
  VolumeOffSolidIcon,
  VolumeOnSolidIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import styles from "./TileActions.module.css";
import { useBehavior } from "../useBehavior";
import {
  formatPlaybackVolume,
  MAX_PLAYBACK_VOLUME,
  type VolumeControls,
} from "../state/VolumeControls";
import { openPopout, poppedOutIds$ } from "./popout";
import { diag } from "../diagnostics/diag";
import { saveSnapshot } from "../diagnostics/snapshot";
import {
  diagnosticsOverlay as diagnosticsOverlaySetting,
  useSetting,
} from "../settings/settings";

/**
 * Whether the element is what the browser shows fullscreen, and the function
 * that makes it so or ends it. Inside a widget the frame has to allow
 * fullscreen (`allow="fullscreen"`), which is the host's to grant.
 */
export function useFullscreen(
  element: RefObject<HTMLElement | null>,
): [boolean, () => void] {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    let was = false;
    const onChange = (): void => {
      const on =
        element.current !== null &&
        document.fullscreenElement === element.current;
      if (on !== was) diag("fullscreen", { where: "tile", on });
      was = on;
      setFullscreen(on);
    };
    document.addEventListener("fullscreenchange", onChange);
    return (): void =>
      document.removeEventListener("fullscreenchange", onChange);
  }, [element]);
  const toggle = useCallback(() => {
    const el = element.current;
    if (el === null) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  }, [element]);
  return [fullscreen, toggle];
}

interface VolumeProps {
  volume: VolumeControls;
  tabIndex: number | undefined;
}

/**
 * A mute button and a slider, in the tile itself rather than in a menu: a
 * menu is drawn outside the tile and so is not there while the tile is shown
 * fullscreen.
 */
const TileVolume: FC<VolumeProps> = ({ volume, tabIndex }) => {
  const { t } = useTranslation();
  const value = useBehavior(volume.playbackVolume$);
  const muted = value === 0;
  const Icon = muted ? VolumeOffSolidIcon : VolumeOnSolidIcon;
  const percent = Math.round(value * 100);
  return (
    <div className={styles.volume}>
      <button
        type="button"
        aria-label={
          muted
            ? t("video_tile.unmute_playback")
            : t("video_tile.mute_playback")
        }
        aria-pressed={muted}
        onClick={volume.togglePlaybackMuted}
        tabIndex={tabIndex}
      >
        <Icon aria-hidden width={20} height={20} />
      </button>
      <input
        type="range"
        aria-label={t("video_tile.volume")}
        title={formatPlaybackVolume(value)}
        min={0}
        max={MAX_PLAYBACK_VOLUME * 100}
        step={1}
        value={percent}
        onChange={(e) =>
          volume.adjustPlaybackVolume(Number(e.target.value) / 100)
        }
        onPointerUp={volume.commitPlaybackVolume}
        onKeyUp={volume.commitPlaybackVolume}
        onBlur={volume.commitPlaybackVolume}
        tabIndex={tabIndex}
      />
      <span className={styles.percent}>{formatPlaybackVolume(value)}</span>
    </div>
  );
};

interface Props {
  /** The video shown, when there is one to show larger. */
  video: VideoMediaTrack | undefined;
  /** Identifies what is shown across tiles and layouts: its window is found again by it. */
  popoutId: string;
  displayName: string;
  mirror: boolean;
  volume?: VolumeControls;
  fullscreen: boolean;
  toggleFullscreen: () => void;
  focusable: boolean;
}

/**
 * What every tile offers on top of its media: the volume of what is heard
 * from it, a window of its own, and the whole screen.
 */
export const TileActions: FC<Props> = ({
  video,
  popoutId,
  displayName,
  mirror,
  volume,
  fullscreen,
  toggleFullscreen,
  focusable,
}) => {
  const { t } = useTranslation();
  const poppedOut = useBehavior(poppedOutIds$).has(popoutId);
  const [diagnosticsMode] = useSetting(diagnosticsOverlaySetting);
  const onSnapshot = useCallback(() => {
    const track = video?.mediaStreamTrack$.value;
    if (track !== undefined) void saveSnapshot(track, popoutId);
  }, [video, popoutId]);
  const tabIndex = focusable ? undefined : -1;

  // A screen share is there to be read, so it is always asked for at its
  // best; a camera only while it fills the screen. (A pop-out window asks
  // for itself, since it outlives the tile.)
  const wantsHighQuality =
    video !== undefined && (video.source === "screenShare" || fullscreen);
  useEffect(() => {
    if (!wantsHighQuality || video === undefined) return;
    return video.requestHighQuality();
  }, [video, wantsHighQuality]);

  const onPopOut = useCallback(() => {
    if (video === undefined) return;
    openPopout({
      id: popoutId,
      // The window is named by words every desktop can show: a participant and what of theirs
      title: `${displayName} – ${video.source === "screenShare" ? "screen" : "camera"}`,
      video,
      volume,
      mirror,
      labels: {
        fullscreen: t("video_tile.fullscreen"),
        mute: t("video_tile.mute_playback"),
        volume: t("video_tile.volume"),
      },
    });
  }, [video, popoutId, displayName, volume, mirror, t]);

  if (video === undefined && volume === undefined) return null;
  const FullscreenIcon = fullscreen ? ExitFullScreenIcon : FullScreenIcon;
  return (
    // Not part of the tile's own gestures: a double click here is two clicks
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={styles.actions}
      data-active={poppedOut || fullscreen}
      data-testid="tile_actions"
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {volume && <TileVolume volume={volume} tabIndex={tabIndex} />}
      {video && (
        <>
          {diagnosticsMode && video.source === "screenShare" && (
            <button
              type="button"
              className={styles.text}
              title={t("diagnostics.snapshot_description")}
              onClick={onSnapshot}
              tabIndex={tabIndex}
              data-testid="tile_snapshot"
            >
              {t("diagnostics.snapshot")}
            </button>
          )}
          <button
            type="button"
            aria-label={t("video_tile.pop_out")}
            title={t("video_tile.pop_out")}
            aria-pressed={poppedOut}
            onClick={onPopOut}
            tabIndex={tabIndex}
            data-testid="tile_pop_out"
          >
            <PopOutIcon aria-hidden width={20} height={20} />
          </button>
          <button
            type="button"
            aria-label={
              fullscreen
                ? t("video_tile.exit_fullscreen")
                : t("video_tile.fullscreen")
            }
            title={
              fullscreen
                ? t("video_tile.exit_fullscreen")
                : t("video_tile.fullscreen")
            }
            onClick={toggleFullscreen}
            tabIndex={tabIndex}
            data-testid="tile_fullscreen"
          >
            <FullscreenIcon aria-hidden width={20} height={20} />
          </button>
        </>
      )}
    </div>
  );
};
