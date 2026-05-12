module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // react-native-reanimated requires its babel plugin to be the
  // *last* plugin in the list. The plugin rewrites worklet
  // functions to run on the UI thread; without it, useAnimatedProps
  // / useDerivedValue silently no-op.
  plugins: ['react-native-reanimated/plugin'],
};
