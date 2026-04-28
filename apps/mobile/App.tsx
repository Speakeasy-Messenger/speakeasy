import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator.js';
import { useIdentity } from './src/store/identity.js';
import { api, getWsClient, signalProtocol, vouchflow } from './src/services.js';
import { makeReplenisher } from './src/crypto/replenish.js';
import { colors } from './src/theme/index.js';

export default function App() {
  const userId = useIdentity((s) => s.userId);

  // Open WebSocket once enrolled. Close + reset when identity is cleared.
  // Note: each (re)connect runs a fresh verify() — that's a biometric prompt
  // on real devices. Phase 4 will cache deviceTokens within their freshness
  // window so reconnects don't re-prompt.
  useEffect(() => {
    if (!userId) return;
    const getToken = async () => {
      const r = await vouchflow.verify({ context: 'login' });
      return r.deviceToken;
    };
    const ws = getWsClient(getToken);
    ws.connect();
    // Server pushes `prekeys_low` when this user's OTPK pool is below
    // threshold (`PREKEY_LOW_WATER` = 10). Replenisher dedupes concurrent
    // signals onto a single in-flight round.
    const replenisher = makeReplenisher({ api, signalProtocol, getDeviceToken: getToken });
    const unsubscribe = ws.subscribe((msg) => {
      if (msg.type === 'prekeys_low') void replenisher.trigger();
    });
    return () => {
      unsubscribe();
      ws.close();
    };
  }, [userId]);

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle="dark-content"
        backgroundColor={colors.cream}
      />
      <RootNavigator />
    </SafeAreaProvider>
  );
}
