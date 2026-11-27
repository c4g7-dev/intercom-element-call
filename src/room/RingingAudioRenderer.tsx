/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect, type FC } from "react";
import { logger } from "matrix-js-sdk/lib/logger";

import { type RingingMediaViewModel } from "../state/media/RingingMediaViewModel";
import { useBehavior } from "../useBehavior";
import { useInitial } from "../useInitial";
import { prefetchSounds } from "../soundUtils";
// InterCom: its own ringback, made by scripts/intercom-sounds.py (ogg only: the
// app is Chromium). The file is one round of the loop, with its rest.
import ringbackOgg from "../sound/intercom_ringback.ogg?url&no-inline";
import { useHostBridge } from "../HostBridge";
import { type UseAudioContext, useAudioContext } from "../useAudioContext";
import { useLatest } from "../useLatest";

/** The pause between two rounds of the ringback, on top of the rest in the file. */
const RINGBACK_GAP_S = 0.1;

interface RingingAudioRendererProps {
  vm: RingingMediaViewModel | null;
  muted: boolean;
}

export const RingingAudioRenderer: FC<RingingAudioRendererProps> = ({
  vm,
  muted,
}) => {
  // Preload a waiting and decline sounds
  const hostBridge = useHostBridge();
  const sounds = useInitial(async () => {
    const builtIn = prefetchSounds({
      ringtone: { ogg: ringbackOgg },
    });
    // InterCom: the host may have a ringback of the user's own to play instead
    const host = await hostBridge.requestSounds().catch(() => undefined);
    return host?.ringback ? { ringtone: host.ringback } : builtIn;
  });
  const audio = useAudioContext({
    sounds,
    latencyHint: "interactive",
    muted,
  });

  return vm && <ActiveRingingAudioRenderer vm={vm} audio={audio} />;
};

interface ActiveRingingAudioRendererProps {
  vm: RingingMediaViewModel;
  audio: UseAudioContext<"ringtone"> | null;
}

const ActiveRingingAudioRenderer: FC<ActiveRingingAudioRendererProps> = ({
  vm,
  audio,
}) => {
  const audio_ = useLatest(audio);
  const pickupState = useBehavior(vm.pickupState$);

  // While ringing, loop the ringtone
  useEffect((): void | (() => void) => {
    if (pickupState === "ringing" && audio_.current) {
      // InterCom: the file has its own rest at the end, so the next round
      // follows at once (a delay there has to be) instead of a file's length later
      const endSound = audio_.current.playSoundLooping(
        "ringtone",
        RINGBACK_GAP_S,
      );
      return () => {
        void endSound().catch((e) => {
          logger.error("Failed to stop ringing sound", e);
        });
      };
    }
  }, [pickupState, audio_]);

  return null;
};
