/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useCallback, useEffect, useMemo, useRef } from "react";

import { useHostBridge } from "../HostBridge";
import { useMediaDevices } from "../MediaDevicesContext";
import {
  screenShareAudioMix,
  screenShareAudioSource,
  screenShareConfigured,
} from "../settings/settings";
import {
  availableShareSources,
  pressShare,
  setShareDialog,
} from "../state/quickShare";
import { shareAudioMix, shareAudioMode } from "../state/shareAudioSink";

export interface ShareControls {
  /**
   * The share button: stops the share that is on, starts one with the
   * settings of the last, or asks for them the first time.
   */
  press: (source: string) => void;
  /** Opens the settings of the next share, or the audio of the one on. */
  openSettings: () => void;
}

/**
 * What the share button and its settings button do, for every place there
 * is one: the call's footer, the keyboard and the host.
 * @param toggle starts or stops the share; absent where there can be none
 */
export function useShareControls(
  toggle: (() => void) | null | undefined,
  sharing: boolean,
  canShowDialog: boolean,
): ShareControls {
  const shareAudio = useHostBridge().shareAudio;
  const devices = useMediaDevices();
  const latest = useRef({ toggle, sharing, canShowDialog });
  useEffect(() => {
    latest.current = { toggle, sharing, canShowDialog };
  }, [toggle, sharing, canShowDialog]);

  const press = useCallback(
    (source: string): void => {
      const { toggle, sharing, canShowDialog } = latest.current;
      if (!toggle) return;
      const choice = screenShareAudioSource.getValue();
      pressShare({
        toggle,
        sharing,
        canShowDialog,
        configured: screenShareConfigured.getValue(),
        mode: shareAudioMode(choice),
        mix: shareAudioMix(choice, screenShareAudioMix.getValue()),
        available: async () => availableShareSources(shareAudio, devices),
        source,
      });
    },
    [shareAudio, devices],
  );
  const openSettings = useCallback((): void => {
    const { toggle, sharing } = latest.current;
    if (!toggle) return;
    // Where no dialog can be shown right now (the call is a small picture in
    // a corner) it opens as soon as one can: the host shows the call first
    setShareDialog(sharing ? "audio" : "settings");
  }, []);
  return useMemo(() => ({ press, openSettings }), [press, openSettings]);
}
