//
//  NotificationService-Bridging-Header.h
//
//  The shared DB sources (SpeakeasyDb, DbKeyStore, DecryptCache, the Signal
//  store) call the SQLCipher C API. Same as the app's bridging header, minus
//  anything React — the extension links SQLCipher (Podfile) and these symbols
//  arrive through this header.
//

#import <sqlite3.h>
