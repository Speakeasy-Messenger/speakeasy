import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

describe('coordinated mobile release contracts', () => {
  it('keeps the react-native-webrtc patch parseable by clean installs', () => {
    const patchPath = resolve(repoRoot, 'apps/mobile/patches/react-native-webrtc+124.0.7.patch');
    const result = spawnSync('git', ['apply', '--numstat', patchPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('builds both Android artifacts in one Gradle invocation', () => {
    const workflow = source('.github/workflows/release-play.yml');

    expect(workflow).toContain('./gradlew :app:assembleRelease :app:bundleRelease --no-daemon');
    expect(workflow).toContain('Upload APK to GitHub release');
    expect(workflow).toContain('Publish to Play Internal');
  });

  it('does not launch the legacy duplicate APK build for release tags', () => {
    const fallback = source('.github/workflows/release.yml');

    expect(fallback).toContain('workflow_dispatch:');
    expect(fallback).not.toContain("tags: ['alpha-*', 'v*']");
  });

  it('archives iOS in parallel but publishes TestFlight after Android beta', () => {
    const workflow = source('.github/workflows/release-play.yml');
    const archiveJob = workflow.slice(
      workflow.indexOf('  ios-archive:'),
      workflow.indexOf('  ios-testflight:'),
    );
    const uploadJob = workflow.slice(workflow.indexOf('  ios-testflight:'));

    expect(archiveJob).not.toContain('needs:');
    expect(workflow).toContain('Promote Android to beta');
    expect(uploadJob).toContain('needs: [android-release, ios-archive]');
    expect(uploadJob).toContain('bundle exec fastlane ios upload_beta');
  });

  it('separates iOS archive from upload and uses globally unique build numbers', () => {
    const workflow = source('.github/workflows/release-play.yml');
    const fallback = source('.github/workflows/release-ios.yml');
    const fastfile = source('apps/mobile/ios/fastlane/Fastfile');

    expect(fastfile).toContain('lane :build_beta do');
    expect(fastfile).toContain('lane :upload_beta do');
    expect(fastfile).toContain('ipa: ENV["IPA_PATH"] || "build/Speakeasy.ipa"');
    expect(workflow).toContain('BUILD_NUMBER: ${{ github.run_id }}');
    expect(fallback).toContain('BUILD_NUMBER: ${{ github.run_id }}');
  });

  // Play Console auto-sends a committed edit for Google review unless the
  // commit carries `changesNotSentForReview=true`. Speakeasy does not use
  // Google review, and an edit left in review makes the NEXT edit on that
  // track fail with HTTP 400 INVALID_ARGUMENT. Guards every publisher
  // script at once so a new one can't reintroduce the bug.
  it('commits every Play edit without sending it for Google review', () => {
    const scriptsDir = resolve(repoRoot, 'scripts');
    const commitLines = readdirSync(scriptsDir)
      .filter((name) => name.endsWith('.sh'))
      .flatMap((name) =>
        source(`scripts/${name}`)
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.includes(':commit') && !line.startsWith('#'))
          .map((line) => `${name}: ${line}`),
      );

    expect(commitLines.length).toBeGreaterThan(0);
    for (const line of commitLines) {
      expect(line).toContain(':commit?changesNotSentForReview=true');
    }
  });
});
