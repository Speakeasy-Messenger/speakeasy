import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mobileRoot = resolve(__dirname, '../..');
const android = readFileSync(
  resolve(
    mobileRoot,
    'android/app/src/main/java/xyz/speakeasyapp/app/MainApplication.kt',
  ),
  'utf8',
);
const ios = readFileSync(
  resolve(mobileRoot, 'ios/SpeakeasyBridges/Vouchflow/VouchflowBootstrap.swift'),
  'utf8',
);

const YE1_PIN = 'brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4=';
const YE2_PIN = 's/tdAOmUzd8syaTuqfgGvFcn6DzA5Cmb+Vby1ST+U3Y=';
const CURRENT_LEAF_PIN = 'mX8Bi7dmXyNH4V/rjrvMcP1ZcxBzrnRmnNPnAvi1kTs=';
const EXPIRED_LEAF_PIN = 'NQ7reZqY0tQjef9LBQwbs0gHjrdrroWrd+scM74zQrU=';

describe('Vouchflow certificate pin rotation', () => {
  it('configures both active issuing intermediates on Android', () => {
    const source = android;
    expect(source).toContain(YE1_PIN);
    expect(source).toContain(YE2_PIN);
    expect(source).not.toContain(EXPIRED_LEAF_PIN);
  });

  it('pins only the current leaf on iOS until SDK trust evaluation is fixed', () => {
    expect(ios).toContain(CURRENT_LEAF_PIN);
    expect(ios).not.toContain(YE1_PIN);
    expect(ios).not.toContain(YE2_PIN);
    expect(ios).not.toContain(EXPIRED_LEAF_PIN);
  });

  it('passes the YE1 and YE2 pins into the Android SDK config', () => {
    expect(android).toMatch(
      /leafCertificatePin\s*=\s*VOUCHFLOW_LETS_ENCRYPT_YE2_PIN/,
    );
    expect(android).toMatch(
      /intermediateCertificatePin\s*=\s*VOUCHFLOW_LETS_ENCRYPT_YE1_PIN/,
    );
  });

  it('passes the current leaf into both iOS SDK pin slots', () => {
    expect(ios).toMatch(/leafCertificatePin:\s*productionLeafPin/);
    expect(ios).toMatch(/intermediateCertificatePin:\s*productionLeafPin/);
  });
});
