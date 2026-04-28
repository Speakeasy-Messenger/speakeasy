module.exports = {
  project: {
    ios: { sourceDir: './ios' },
    android: {
      sourceDir: './android',
      packageName: 'xyz.speakeasyapp.app',
    },
  },
  // Phase 5e: Inter fonts loaded from android/app/src/main/assets/fonts/
  // and (iOS, queued) ios/Speakeasy/. `npx react-native-asset` copies into both.
  assets: ['./android/app/src/main/assets/fonts/'],
};
