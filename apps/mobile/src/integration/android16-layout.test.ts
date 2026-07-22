import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mobileRoot = resolve(__dirname, '../..');

function source(relativePath: string): string {
  return readFileSync(resolve(mobileRoot, relativePath), 'utf8');
}

describe('Android 16 edge-to-edge layout contracts', () => {
  it('keeps the Android build on API 36 with a compatible Gradle plugin', () => {
    const gradle = source('android/build.gradle');

    expect(gradle).toContain('compileSdkVersion = 36');
    expect(gradle).toContain('targetSdkVersion = 36');
    expect(gradle).toContain('com.android.tools.build:gradle:8.9.1');
  });

  it('runs release and emulator CI against API 36', () => {
    const releaseWorkflow = source('../../.github/workflows/release-play.yml');
    const emulatorWorkflow = source('../../.github/workflows/tier-b-emulator.yml');

    expect(releaseWorkflow).toContain('platforms;android-36 build-tools;36.0.0');
    expect(emulatorWorkflow).toContain('api-level: 36');
  });

  it('resizes the whole navigator above the Android IME', () => {
    const app = source('App.tsx');

    expect(app).toContain('<KeyboardAvoidingView');
    expect(app).toContain(
      "behavior={Platform.OS === 'android' ? 'height' : undefined}",
    );
    expect(app.indexOf('<KeyboardAvoidingView')).toBeLessThan(
      app.indexOf('<RootNavigator'),
    );
  });

  it('uses light system-bar icons whenever the dark brand canvas is visible', () => {
    const app = source('App.tsx');

    expect(app).toContain(
      '<ThemedStatusBar brandCanvas={!userId || showSplash} />',
    );
    expect(app).toContain(
      "barStyle={brandCanvas || t.mode === 'dark' ? 'light-content' : 'dark-content'}",
    );
  });
});
