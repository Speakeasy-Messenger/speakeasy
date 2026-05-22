import { EventEmitter } from 'node:events';

/**
 * ioredis-mock shares a process-level EventEmitter for keyspace changes
 * and pub/sub channels. The cross-instance suites intentionally create
 * many clients in one worker, so the default listener limit warns even
 * when every cluster is closed. Raise it only in those test fixtures.
 */
export function raiseIoredisMockListenerLimit(): void {
  if (EventEmitter.defaultMaxListeners < 500) {
    EventEmitter.defaultMaxListeners = 500;
  }
}
