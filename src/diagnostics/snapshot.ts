/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describeError, diag } from "./diag";

/**
 * The start of a snapshot's file name. The application hosting Element Call
 * saves a PNG downloaded under such a name into its diagnostics folder
 * without asking where to, so this is a contract with the host.
 */
export const SNAPSHOT_FILE_PREFIX = "intercom-snapshot-";

export function snapshotFileName(participant: string): string {
  const safe = participant.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
  return `${SNAPSHOT_FILE_PREFIX}${safe || "unknown"}.png`;
}

/**
 * Saves the frame a video track shows right now as a PNG, exactly as it was
 * decoded: a download, which the desktop host files with its diagnostics.
 * Only ever on the user's own click.
 */
export async function saveSnapshot(
  track: MediaStreamTrack,
  participant: string,
): Promise<boolean> {
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    await video.play();
    if (video.videoWidth === 0)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("No frame arrived")),
          3000,
        );
        video.addEventListener(
          "resize",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    video.pause();
    video.srcObject = null;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (blob === null) throw new Error("The frame could not be encoded");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = snapshotFileName(participant);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    diag("snapshot", {
      participant,
      file: link.download,
      width: canvas.width,
      height: canvas.height,
      bytes: blob.size,
    });
    return true;
  } catch (e) {
    diag("snapshot", { participant, error: describeError(e) });
    return false;
  }
}
