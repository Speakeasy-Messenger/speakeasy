import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAlert,
  mockPickSingle,
  mockIsCancel,
  mockReadFile,
  mockLaunchCamera,
  mockLaunchImageLibrary,
  mockEnsureCameraPermission,
} = vi.hoisted(() => ({
  mockAlert: vi.fn(),
  mockPickSingle: vi.fn(),
  mockIsCancel: vi.fn(),
  mockReadFile: vi.fn(),
  mockLaunchCamera: vi.fn(),
  mockLaunchImageLibrary: vi.fn(),
  mockEnsureCameraPermission: vi.fn(),
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    Alert: { alert: mockAlert },
  };
});

vi.mock('react-native-document-picker', () => ({
  default: {
    types: { allFiles: '*/*' },
    pickSingle: mockPickSingle,
    isCancel: mockIsCancel,
  },
}));

vi.mock('react-native-fs', () => ({
  default: {
    readFile: mockReadFile,
  },
}));

vi.mock('react-native-image-picker', () => ({
  launchCamera: mockLaunchCamera,
  launchImageLibrary: mockLaunchImageLibrary,
}));

vi.mock('../permissions/runtime.js', () => ({
  ensureCameraPermission: mockEnsureCameraPermission,
}));

import { pickFile, pickFromCamera, pickPhotos, readablePathFromDocumentUri } from './pick.js';

describe('readablePathFromDocumentUri', () => {
  it('decodes copied file URIs before passing them to RNFS', () => {
    expect(
      readablePathFromDocumentUri('file:///data/user/0/cache/My%20File%20%231.pdf'),
    ).toBe('/data/user/0/cache/My File #1.pdf');
  });

  it('leaves non-file URIs unchanged', () => {
    expect(readablePathFromDocumentUri('content://provider/document/1')).toBe(
      'content://provider/document/1',
    );
  });
});

describe('pickFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCancel.mockReturnValue(false);
    mockEnsureCameraPermission.mockResolvedValue('granted');
  });

  it('reads the copied cache file and returns a file attachment', async () => {
    mockPickSingle.mockResolvedValue({
      fileCopyUri: 'file:///data/user/0/cache/hello%20world.txt',
      uri: 'content://provider/document/1',
      name: 'hello world.txt',
      type: 'text/plain',
      size: 5,
    });
    mockReadFile.mockResolvedValue('aGVsbG8=');

    await expect(pickFile()).resolves.toEqual({
      kind: 'file',
      mime: 'text/plain',
      data: 'aGVsbG8=',
      name: 'hello world.txt',
    });
    expect(mockReadFile).toHaveBeenCalledWith('/data/user/0/cache/hello world.txt', 'base64');
  });

  it('alerts and skips files rejected by picker metadata size', async () => {
    mockPickSingle.mockResolvedValue({
      fileCopyUri: 'file:///data/user/0/cache/large.pdf',
      uri: 'content://provider/document/1',
      name: 'large.pdf',
      type: 'application/pdf',
      size: 800_001,
    });

    await expect(pickFile()).resolves.toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith(
      'File is too large',
      expect.stringContaining('800 KB'),
    );
  });

  it('enforces the size cap after reading when providers omit size', async () => {
    mockPickSingle.mockResolvedValue({
      fileCopyUri: 'file:///data/user/0/cache/unknown.bin',
      uri: 'content://provider/document/1',
      name: 'unknown.bin',
      type: null,
      size: null,
    });
    mockReadFile.mockResolvedValue('a'.repeat(1_066_672));

    await expect(pickFile()).resolves.toBeNull();
    expect(mockAlert).toHaveBeenCalledWith(
      'File is too large',
      expect.stringContaining('800 KB'),
    );
  });

  it('shows a useful attachment error instead of throwing', async () => {
    mockPickSingle.mockResolvedValue({
      fileCopyUri: 'file:///data/user/0/cache/bad.pdf',
      uri: 'content://provider/document/1',
      name: 'bad.pdf',
      type: 'application/pdf',
      size: 123,
    });
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await expect(pickFile()).resolves.toBeNull();
    expect(mockAlert).toHaveBeenCalledWith('Could not attach file', 'ENOENT');
  });

  it('swallows user cancellation', async () => {
    const cancel = new Error('cancelled');
    mockPickSingle.mockRejectedValue(cancel);
    mockIsCancel.mockReturnValue(true);

    await expect(pickFile()).resolves.toBeNull();
    expect(mockAlert).not.toHaveBeenCalled();
  });
});

describe('pickPhotos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts resized base64 photos even when picker fileSize reports the original large file', async () => {
    mockLaunchImageLibrary.mockResolvedValue({
      assets: [
        {
          base64: 'aGVsbG8=',
          fileSize: 4_000_000,
          type: 'image/jpeg',
        },
      ],
    });

    await expect(pickPhotos({ selectionLimit: 1 })).resolves.toEqual([
      {
        kind: 'image',
        mime: 'image/jpeg',
        data: 'aGVsbG8=',
      },
    ]);
  });

  it('alerts only when every selected photo is still too large after resizing', async () => {
    mockLaunchImageLibrary.mockResolvedValue({
      assets: [
        {
          base64: 'a'.repeat(1_066_672),
          type: 'image/jpeg',
        },
      ],
    });

    await expect(pickPhotos({ selectionLimit: 1 })).resolves.toEqual([]);
    expect(mockAlert).toHaveBeenCalledWith(
      'Photo is too large',
      expect.stringContaining('800 KB'),
    );
  });
});

describe('pickFromCamera', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureCameraPermission.mockResolvedValue('granted');
  });

  it('accepts captured resized base64 even when picker fileSize reports the original large file', async () => {
    mockLaunchCamera.mockResolvedValue({
      assets: [
        {
          base64: 'aGVsbG8=',
          fileSize: 4_000_000,
          type: 'image/jpeg',
        },
      ],
    });

    await expect(pickFromCamera()).resolves.toEqual({
      kind: 'image',
      mime: 'image/jpeg',
      data: 'aGVsbG8=',
    });
  });
});
