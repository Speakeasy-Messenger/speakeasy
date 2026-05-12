import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Attachment } from '@speakeasy/shared';
import { Platform } from 'react-native';

// Use vi.hoisted so the mock factories can reference these at hoist time
const { mockExists, mockMkdir, mockWriteFile, mockScanFile } = vi.hoisted(() => ({
  mockExists: vi.fn<() => Promise<boolean>>(),
  mockMkdir: vi.fn<() => Promise<void>>(),
  mockWriteFile: vi.fn<() => Promise<void>>(),
  mockScanFile: vi.fn<() => Promise<void>>(),
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
}));

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
  });

  it('writes to ExternalDirectoryPath on Android (not DownloadDirectoryPath)', async () => {
    // @ts-expect-error - mutating mock Platform
    Platform.OS = 'android';
    await saveAndAnnounceFile(baseAttachment);

    const destArg = mockWriteFile.mock.calls[0]?.[0] as string;
    expect(destArg).toContain('/data/external');
    expect(destArg).not.toContain('/storage/emulated/0/Download');
  });

  it('writes to DocumentDirectoryPath on iOS', async () => {
    // @ts-expect-error - mutating mock Platform
    Platform.OS = 'ios';
    await saveAndAnnounceFile(baseAttachment);

    const destArg = mockWriteFile.mock.calls[0]?.[0] as string;
    expect(destArg).toContain('/data/documents');
  });

  it('creates the directory if it does not exist', async () => {
    // @ts-expect-error - mutating mock Platform
    Platform.OS = 'android';
    mockExists.mockResolvedValue(false);
    await saveAndAnnounceFile(baseAttachment);

    expect(mockMkdir).toHaveBeenCalledWith('/data/external');
  });

  it('skips mkdir when the directory already exists', async () => {
    // @ts-expect-error - mutating mock Platform
    Platform.OS = 'android';
    mockExists.mockResolvedValue(true);
    await saveAndAnnounceFile(baseAttachment);

    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('calls scanFile on Android to register with MediaStore', async () => {
    // @ts-expect-error - mutating mock Platform
    Platform.OS = 'android';
    await saveAndAnnounceFile(baseAttachment);

    expect(mockScanFile).toHaveBeenCalled();
  });

  it('does not call scanFile on iOS', async () => {
    // @ts-expect-error - mutating mock Platform
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
    // @ts-expect-error - mutating mock Platform
    Platform.OS = 'android';
    await saveAndAnnounceFile(evil);

    const destArg = mockWriteFile.mock.calls[0]?.[0] as string;
    expect(destArg).not.toContain('../');
  });
});
