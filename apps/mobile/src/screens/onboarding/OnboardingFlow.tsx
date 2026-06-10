import React, { useState } from 'react';
import { useIdentity } from '../../store/identity.js';
import { useProfiles } from '../../store/profiles.js';
import { DoorStep } from './DoorStep.js';
import { RoomStep } from './RoomStep.js';
import { HandleStep } from './HandleStep.js';
import { FaceStep } from './FaceStep.js';
import { PermissionsStep } from './PermissionsStep.js';
import { InviteStep } from './InviteStep.js';

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

type Step = 'door' | 'room' | 'handle' | 'face' | 'permissions' | 'invite';

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
            // user's selected animal immediately when we eventually
            // flip into Conversations. We do NOT call setUserId here
            // anymore — that would trigger App.tsx's auth-routing
            // flip and skip the Permissions step. setUserId is called
            // by the Permissions step's onContinue.
            useProfiles.getState().set(claimed.userId, {
              selectedAvatarId: animalId,
              fetchedAt: Date.now(),
            });
            setStep('permissions');
          }}
        />
      );
    case 'permissions':
      if (!claimed) {
        // Same defensive path as 'face' — shouldn't hit; recover by
        // restarting the handle flow.
        setStep('handle');
        return <HandleStep onClaimed={(args) => { setClaimed(args); setStep('face'); }} />;
      }
      return (
        <PermissionsStep
          onContinue={() => {
            // One more onboarding screen (Invite) before the routing flip.
            setStep('invite');
          }}
        />
      );
    case 'invite':
      if (!claimed) {
        // Same defensive path as 'face' / 'permissions'.
        setStep('handle');
        return <HandleStep onClaimed={(args) => { setClaimed(args); setStep('face'); }} />;
      }
      return (
        <InviteStep
          handle={claimed.userId}
          onContinue={() => {
            // NOW flip the App-level routing into Conversations — kept as
            // the very last onboarding action so enrollment timing is
            // unchanged (App.tsx routes on userId).
            useIdentity.getState().setDeviceToken(claimed.deviceToken);
            useIdentity.getState().setUserId(claimed.userId);
            onEnrolled(claimed.userId);
          }}
        />
      );
  }
}
