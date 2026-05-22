import { NativeModules, Platform, Share } from 'react-native';

type NativeFileOpener = {
  openFile(path: string, mime: string): Promise<boolean>;
};

const native = (NativeModules as { SpeakeasyFileOpener?: NativeFileOpener })
  .SpeakeasyFileOpener;

export async function openSavedFile(path: string, mime: string): Promise<void> {
  if (Platform.OS === 'android') {
    if (!native) throw new Error('file_opener_unavailable');
    await native.openFile(path, mime || '*/*');
    return;
  }

  await Share.share({
    url: path.startsWith('file://') ? path : `file://${path}`,
  });
}
