import type { EventLogRecord, EventLogRepo, RecordedEvent } from './event-log.js';

export class InMemoryEventLogRepo implements EventLogRepo {
  readonly rows: RecordedEvent[] = [];
  private nextId = 1;

  async record(entry: EventLogRecord): Promise<void> {
    this.rows.push({
      id: this.nextId++,
      ts: new Date(),
      eventType: entry.eventType,
      userId: entry.userId ?? null,
      payload: entry.payload ?? {},
    });
  }

  async recentForUser(userId: string, limit = 50): Promise<RecordedEvent[]> {
    return this.rows
      .filter((r) => r.userId === userId)
      .slice(-limit)
      .reverse();
  }
}
