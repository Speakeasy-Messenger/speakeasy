import React, { useState } from 'react';
import { useIdentity } from '../../store/identity.js';
import { useProfiles } from '../../store/profiles.js';
import { DoorStep } from './DoorStep.js';
import { RoomStep } from './RoomStep.js';
import { HandleStep } from './HandleStep.js';
import { FaceStep } from './FaceStep.js';

/**
 * Onboarding orchestrator — Phase 3 brand overhaul.
 * Spec: ONBOARDING.md §2 (the four screens) + §4 (state machine).
 *
 * Door → Room → Handle → Face. Server-side identity is created at the
 * end of Handle (api.enroll); the Face step's `setAvatar` is the last
 * step before identity.setUserId triggers the App-level routing flip
 * to the conversation list.
 *
 * Why the userId set is deferred to the Face step's onPicked callback:
 * App.tsx routes `!userId` → onboarding, `userId` → conversation list.
 * If we called identity.setUserId right after api.enroll, the Face
 * step would never render — the user would be punted into the
 * conversation list with a still-blank avatar. Holding the userId in
 * local state until Face is confirmed gives us the canvas crossfade
 * moment the spec calls for, and lets the user back out (close + relaunch)
 * without server state if they bail mid-Face. (Acceptable since the
 * server-side row already exists; if they bail, the next launch sees a
 * userless identity store and offers fresh enrollment, which then 409s
 * on the same handle. Edge case worth a follow-up.)
 */

interface Props {
  onEnrolled: (userId: string) => void;
}

type Step = 'door' | 'room' | 'handle' | 'face';

interface ClaimedIdentity {
  userId: string;
  deviceToken: string;
}

export function OnboardingFlow({ onEnrolled }: Props): React.ReactElement {
  const [step, setStep] = useState<Step>('door');
  const [claimed, setClaimed] = useState<ClaimedIdentity | undefined>();

  switch (step) {
    case 'door':
      return <DoorStep onContinue={() => setStep('room')} />;
    case 'room':
      return <RoomStep onContinue={() => setStep('handle')} />;
    case 'handle':
      return (
        <HandleStep
          onClaimed={(args) => {
            setClaimed(args);
            setStep('face');
          }}
        />
      );
    case 'face':
      if (!claimed) {
        // Defensive — shouldn't hit. State machine guarantees the
        // claimed identity exists before transitioning to face.
        setStep('handle');
        return <HandleStep onClaimed={(args) => { setClaimed(args); setStep('face'); }} />;
      }
      return (
        <FaceStep
          deviceToken={claimed.deviceToken}
          onPicked={(animalId) => {
            // Persist locally so the conversation list renders the
            // user's selected animal immediately. App.tsx's startup
            // catch-up would do this on next launch, but we prefer
            // the immediate-render path since the user just picked.
            useProfiles.getState().set(claimed.userId, {
              selectedAvatarId: animalId,
              fetchedAt: Date.now(),
            });
            // Setting deviceToken first → setUserId triggers the
            // App-level routing flip, and the WS auth that follows
            // immediately reads the token off the store.
            useIdentity.getState().setDeviceToken(claimed.deviceToken);
            useIdentity.getState().setUserId(claimed.userId);
            onEnrolled(claimed.userId);
          }}
        />
      );
  }
}
