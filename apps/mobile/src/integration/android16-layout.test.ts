import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mobileRoot = resolve(__dirname, '../..');

function source(relativePath: string): string {
  return readFileSync(resolve(mobileRoot, relativePath), 'utf8');
}

describe('Android 16 edge-to-edge layout contracts', () => {
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
