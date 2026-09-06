import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

/**
 * The iOS privacy manifest (`ios/Speakeasy/PrivacyInfo.xcprivacy`) is the
 * declaration Apple reads at submission time, and it must agree exactly with
 * the App Store privacy label already published for Speakeasy. This test
 * parses the plist into a typed model and compares meaning — not text — so a
 * re-ordered or re-indented manifest still passes, while any type added,
 * dropped, or flipped (Linked / Tracking / Purpose) fails.
 *
 * Published label (source of truth, App Store Connect → App Privacy):
 *   Email Address          Linked=true   App Functionality
 *   User ID                Linked=false  App Functionality
 *   Device ID              Linked=false  App Functionality
 *   Crash Data             Linked=false  Analytics
 *   Other Diagnostic Data  Linked=false  Analytics
 *   (all Tracking=false; NSPrivacyTracking=false)
 *
 * `fast-xml-parser` is the XML parser the React Native iOS CLI itself ships
 * with (`@react-native-community/cli-platform-apple`), so it is always present
 * wherever this package installs.
 */

const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'ios',
  'Speakeasy',
  'PrivacyInfo.xcprivacy',
);

type PlistValue =
  | string
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue };
type PlistDict = { [key: string]: PlistValue };

/** One element in fast-xml-parser's `preserveOrder` output. */
type OrderedNode = { [tag: string]: OrderedNode[] | string | undefined };

function text(children: OrderedNode[]): string {
  return children.map((c) => (typeof c['#text'] === 'string' ? c['#text'] : '')).join('');
}

function tagOf(node: OrderedNode): { tag: string; children: OrderedNode[] } {
  const tag = Object.keys(node).find((k) => k !== ':@' && k !== '#text');
  if (tag === undefined) throw new Error('element without a tag');
  const children = node[tag];
  return { tag, children: Array.isArray(children) ? children : [] };
}

/** Convert one plist XML element into a JS value. */
function plistNode(node: OrderedNode): PlistValue {
  const { tag, children } = tagOf(node);
  switch (tag) {
    case 'string':
      return text(children);
    case 'true':
      return true;
    case 'false':
      return false;
    case 'array':
      return children.map(plistNode);
    case 'dict': {
      const out: PlistDict = {};
      for (let i = 0; i + 1 < children.length; i += 2) {
        const keyNode = children[i];
        const valueNode = children[i + 1];
        if (keyNode === undefined || valueNode === undefined) break;
        const keyChildren = keyNode.key;
        out[Array.isArray(keyChildren) ? text(keyChildren) : ''] = plistNode(valueNode);
      }
      return out;
    }
    default:
      throw new Error(`unsupported plist element <${tag}>`);
  }
}

function loadManifest(): PlistDict {
  const xml = readFileSync(MANIFEST_PATH, 'utf8');
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });
  const doc = parser.parse(xml) as OrderedNode[];
  const plist = doc.find((n) => Array.isArray(n.plist));
  const rootDict = plist && Array.isArray(plist.plist)
    ? plist.plist.find((n) => Array.isArray(n.dict))
    : undefined;
  if (rootDict === undefined) throw new Error('no <plist><dict> root');
  return plistNode(rootDict) as PlistDict;
}

type Declared = { linked: boolean; tracking: boolean; purposes: string[] };

/** Index NSPrivacyCollectedDataTypes by data type so the comparison is order-independent. */
function collectedTypes(manifest: PlistDict): Record<string, Declared> {
  const entries = manifest.NSPrivacyCollectedDataTypes as PlistDict[];
  const out: Record<string, Declared> = {};
  for (const e of entries) {
    const type = e.NSPrivacyCollectedDataType as string;
    expect(out[type], `duplicate declaration for ${type}`).toBeUndefined();
    out[type] = {
      linked: e.NSPrivacyCollectedDataTypeLinked as boolean,
      tracking: e.NSPrivacyCollectedDataTypeTracking as boolean,
      purposes: [...(e.NSPrivacyCollectedDataTypePurposes as string[])].sort(),
    };
  }
  return out;
}

const APP_FUNCTIONALITY = 'NSPrivacyCollectedDataTypePurposeAppFunctionality';
const ANALYTICS = 'NSPrivacyCollectedDataTypePurposeAnalytics';

const PUBLISHED_LABEL: Record<string, Declared> = {
  NSPrivacyCollectedDataTypeEmailAddress: { linked: true, tracking: false, purposes: [APP_FUNCTIONALITY] },
  NSPrivacyCollectedDataTypeUserID: { linked: false, tracking: false, purposes: [APP_FUNCTIONALITY] },
  NSPrivacyCollectedDataTypeDeviceID: { linked: false, tracking: false, purposes: [APP_FUNCTIONALITY] },
  NSPrivacyCollectedDataTypeCrashData: { linked: false, tracking: false, purposes: [ANALYTICS] },
  NSPrivacyCollectedDataTypeOtherDiagnosticData: { linked: false, tracking: false, purposes: [ANALYTICS] },
};

describe('iOS privacy manifest', () => {
  const manifest = loadManifest();

  it('declares exactly the data types on the published App Store privacy label, with matching Linked/Tracking/Purpose', () => {
    // toEqual on the whole map catches extra types (e.g. the E2E-content
    // entries removed as Not Collected), missing types, and any flipped value
    // in one assertion, with a readable diff.
    expect(collectedTypes(manifest)).toEqual(PUBLISHED_LABEL);
  });

  it('does not declare tracking at the app level', () => {
    expect(manifest.NSPrivacyTracking).toBe(false);
  });

  it('keeps the required-reason API declarations for the APIs the app uses', () => {
    const api = manifest.NSPrivacyAccessedAPITypes as PlistDict[];
    const byType = Object.fromEntries(
      api.map((e) => [e.NSPrivacyAccessedAPIType as string, e.NSPrivacyAccessedAPITypeReasons]),
    );
    expect(byType).toEqual({
      NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1'],
      NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
      NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1'],
    });
  });
});
