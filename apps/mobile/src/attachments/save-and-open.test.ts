import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Attachment } from '@speakeasy/shared';
import { Platform } from 'react-native';

// Use vi.hoisted so the mock factories can reference these at hoist time
const {
  mockExists,
  mockMkdir,
  mockWriteFile,
  mockScanFile,
  mockOpenSavedFile,
  mockAlert,
} = vi.hoisted(() => ({
  mockExists: vi.fn<() => Promise<boolean>>(),
  mockMkdir: vi.fn<() => Promise<void>>(),
  mockWriteFile: vi.fn<(path: string, content: string, encoding: string) => Promise<void>>(),
  mockScanFile: vi.fn<(path: string) => Promise<void>>(),
  mockOpenSavedFile: vi.fn<(path: string, mime: string) => Promise<void>>(),
  mockAlert: vi.fn(),
}));

vi.mock('react-native-fs', () => ({
  default: {
    ExternalDirectoryPath: '/data/external',
    DocumentDirectoryPath: '/data/documents',
    DownloadDirectoryPath: '/storage/emulated/0/Download',
    exists: mockExists,
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    scanFile: mockScanFile,
  },
}));

vi.mock('../diag/log.js', () => ({
  diag: vi.fn(),
  diagFingerprint: (s: string) => `fp(${s})`,
}));

vi.mock('../native/file-opener.js', () => ({
  openSavedFile: mockOpenSavedFile,
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    Alert: { alert: mockAlert },
  };
});

import { saveAndAnnounceFile } from './save-and-open.js';

describe('saveAndAnnounceFile', () => {
  const baseAttachment: Attachment = {
    kind: 'file',
    mime: 'text/markdown',
    data: 'SGVsbG8gV29ybGQ=',
    name: 'notes.md',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockResolvedValue(true);
    mockWriteFile.mockResolvedValue(undefined);
    mockScanFile.mockResolvedValue(undefined);
    mockOpenSavedFile.mockResolvedValue(undefined);
  });

  it('writes to ExternalDirectoryPath on Android (not DownloadDirectoryPath)', async () => {
    Platform.OS = 'android';
    await saveAndAnnounceFile(baseAttachment);

    const destArg = mockWriteFile.mock.calls[0]![0] as string;
    expect(destArg).toContain('/data/external');
    expect(destArg).not.toContain('/storage/emulated/0/Download');
  });

  it('writes to DocumentDirectoryPath on iOS', async () => {
    Platform.OS = 'ios';
    await saveAndAnnounceFile(baseAttachment);

    const destArg = mockWriteFile.mock.calls[0]![0] as string;
    expect(destArg).toContain('/data/documents');
  });

  it('creates the directory if it does not exist', async () => {
    Platform.OS = 'android';
    mockExists.mockResolvedValue(false);
    await saveAndAnnounceFile(baseAttachment);

    expect(mockMkdir).toHaveBeenCalledWith('/data/external');
  });

  it('skips mkdir when the directory already exists', async () => {
    Platform.OS = 'android';
    mockExists.mockResolvedValue(true);
    await saveAndAnnounceFile(baseAttachment);

    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('calls scanFile on Android to register with MediaStore', async () => {
    Platform.OS = 'android';
    await saveAndAnnounceFile(baseAttachment);

    expect(mockScanFile).toHaveBeenCalled();
  });

  it('opens the saved file instead of alerting with a path', async () => {
    Platform.OS = 'android';
    await saveAndAnnounceFile(baseAttachment);

    expect(mockOpenSavedFile).toHaveBeenCalledWith('/data/external/notes.md', 'text/markdown');
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('shows a fallback alert only when opening fails', async () => {
    Platform.OS = 'android';
    mockOpenSavedFile.mockRejectedValue(new Error('no viewer'));
    await saveAndAnnounceFile(baseAttachment);

    expect(mockAlert).toHaveBeenCalledWith(
      'Saved',
      expect.stringContaining('no app could be opened'),
    );
  });

  it('does not call scanFile on iOS', async () => {
    Platform.OS = 'ios';
    await saveAndAnnounceFile(baseAttachment);

    expect(mockScanFile).not.toHaveBeenCalled();
  });

  it('sanitizes filenames with path separators', async () => {
    const evil: Attachment = {
      kind: 'file',
      mime: 'text/plain',
      data: 'dGVzdA==',
      name: '../../../etc/passwd.md',
    };
    Platform.OS = 'android';
    await saveAndAnnounceFile(evil);

    const destArg = mockWriteFile.mock.calls[0]![0] as string;
    expect(destArg).not.toContain('../');
  });
});
