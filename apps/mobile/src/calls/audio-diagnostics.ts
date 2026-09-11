import { diagFingerprint } from '../diag/log.js';

type StatsReport = Record<string, unknown>;

export interface AudioCounterState {
  at: number;
  outbound: Record<string, { packets: number | null; bytes: number | null }>;
  inbound: Record<string, { packets: number | null; bytes: number | null }>;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function audio(report: StatsReport): boolean {
  return report.kind === 'audio' || report.mediaType === 'audio';
}

function delta(current: number | null, previous: number | null | undefined): number | null {
  return current === null || previous === null || previous === undefined
    ? null
    : Math.max(0, current - previous);
}

function safeCodec(report: StatsReport | undefined): Record<string, unknown> | null {
  if (!report) return null;
  const mime = text(report.mimeType);
  return {
    name: mime ? mime.replace(/^audio\//i, '').replace(/[^a-z0-9._-]/gi, '') : null,
    clockRate: finite(report.clockRate),
    channels: finite(report.channels),
  };
}

function safeTrack(track: any): Record<string, unknown> | null {
  if (!track || track.kind !== 'audio') return null;
  return {
    idFp: typeof track.id === 'string' ? diagFingerprint(track.id) : null,
    enabled: typeof track.enabled === 'boolean' ? track.enabled : null,
    muted: typeof track.muted === 'boolean' ? track.muted : null,
    readyState: text(track.readyState),
  };
}

/** Build a metadata-only snapshot. Unknown native/stat fields stay explicit nulls. */
export function summarizeAudioPeer(
  reports: StatsReport[],
  peer: any,
  previous: AudioCounterState | undefined,
  now: number,
): { snapshot: Record<string, unknown>; counters: AudioCounterState } {
  const codecs = new Map<string, StatsReport>();
  for (const report of reports) {
    if (report.type === 'codec' && typeof report.id === 'string') codecs.set(report.id, report);
  }
  const next: AudioCounterState = { at: now, outbound: {}, inbound: {} };
  const sources: Record<string, unknown>[] = [];
  const outbound: Record<string, unknown>[] = [];
  const inbound: Record<string, unknown>[] = [];

  for (const report of reports) {
    if (!audio(report)) continue;
    if (report.type === 'media-source') {
      sources.push({
        trackFp: typeof report.trackIdentifier === 'string' ? diagFingerprint(report.trackIdentifier) : null,
        audioLevel: finite(report.audioLevel),
        totalAudioEnergy: finite(report.totalAudioEnergy),
        totalSamplesDuration: finite(report.totalSamplesDuration),
      });
    } else if (report.type === 'outbound-rtp') {
      const key = String(report.ssrc ?? report.id ?? outbound.length);
      const fp = diagFingerprint(key);
      const packets = finite(report.packetsSent);
      const bytes = finite(report.bytesSent);
      next.outbound[fp] = { packets, bytes };
      outbound.push({
        ssrcFp: fp,
        packetsSent: packets,
        packetsSentDelta: delta(packets, previous?.outbound[fp]?.packets),
        bytesSent: bytes,
        bytesSentDelta: delta(bytes, previous?.outbound[fp]?.bytes),
        audioLevel: finite(report.audioLevel),
        active: bool(report.active),
        codec: safeCodec(codecs.get(String(report.codecId))),
      });
    } else if (report.type === 'inbound-rtp') {
      const key = String(report.ssrc ?? report.id ?? inbound.length);
      const fp = diagFingerprint(key);
      const packets = finite(report.packetsReceived);
      const bytes = finite(report.bytesReceived);
      next.inbound[fp] = { packets, bytes };
      inbound.push({
        ssrcFp: fp,
        packetsReceived: packets,
        packetsReceivedDelta: delta(packets, previous?.inbound[fp]?.packets),
        bytesReceived: bytes,
        bytesReceivedDelta: delta(bytes, previous?.inbound[fp]?.bytes),
        packetsLost: finite(report.packetsLost),
        jitter: finite(report.jitter),
        audioLevel: finite(report.audioLevel),
        totalAudioEnergy: finite(report.totalAudioEnergy),
        totalSamplesDuration: finite(report.totalSamplesDuration),
        jitterBufferEmittedCount: finite(report.jitterBufferEmittedCount),
        concealedSamples: finite(report.concealedSamples),
        silentConcealedSamples: finite(report.silentConcealedSamples),
        codec: safeCodec(codecs.get(String(report.codecId))),
      });
    }
  }

  const senders = Array.from(peer.getSenders?.() ?? []).flatMap((sender: any) => {
    const track = safeTrack(sender.track);
    if (!track) return [];
    let parameters: any = {};
    try {
      parameters = sender.getParameters?.() ?? {};
    } catch {
      parameters = { encodings: null };
    }
    const encodings = Array.isArray(parameters.encodings)
      ? parameters.encodings.map((encoding: any) => ({
          active: bool(encoding.active),
          maxBitrate: finite(encoding.maxBitrate),
          codecPayloadType: finite(encoding.codecPayloadType),
        }))
      : null;
    return [{ track, encodings }];
  });
  const receivers = Array.from(peer.getReceivers?.() ?? []).flatMap((receiver: any) => {
    const track = safeTrack(receiver.track);
    return track ? [{ track }] : [];
  });
  const transceivers = Array.from(peer.getTransceivers?.() ?? []).flatMap((transceiver: any) => {
    const track = safeTrack(transceiver.sender?.track) ?? safeTrack(transceiver.receiver?.track);
    if (!track) return [];
    return [{
      mid: text(transceiver.mid),
      direction: text(transceiver.direction),
      currentDirection: text(transceiver.currentDirection),
      stopped: bool(transceiver.stopped),
    }];
  });

  return {
    snapshot: {
      intervalMs: previous ? Math.max(0, now - previous.at) : null,
      sources,
      outbound,
      inbound,
      localTracks: Array.from(peer.localStream?.getAudioTracks?.() ?? []).map(safeTrack),
      senders,
      receivers,
      transceivers,
    },
    counters: next,
  };
}

/** Parse only the audio m-section and rtpmap metadata; never returns full SDP/candidates. */
export function summarizeAudioSdp(sdp: string): Record<string, unknown> {
  const lines = sdp.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('m=audio '));
  if (start < 0) return { present: false, port: null, protocol: null, direction: null, rejected: null, codecs: [] };
  const endOffset = lines.slice(start + 1).findIndex((line) => line.startsWith('m='));
  const section = lines.slice(start, endOffset < 0 ? undefined : start + 1 + endOffset);
  const parts = section[0]!.slice(2).split(/\s+/);
  const direction = section.find((line) => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line));
  const codecs = section.flatMap((line) => {
    const match = line.match(/^a=rtpmap:\d+ ([A-Za-z0-9._-]+)\/(\d+)(?:\/(\d+))?$/);
    return match ? [{ name: match[1], clockRate: Number(match[2]), channels: match[3] ? Number(match[3]) : 1 }] : [];
  });
  return {
    present: true,
    port: /^\d+$/.test(parts[1] ?? '') ? Number(parts[1]) : null,
    protocol: /^[A-Za-z0-9/._-]+$/.test(parts[2] ?? '') ? parts[2] : null,
    direction: direction ? direction.slice(2) : null,
    rejected: parts[1] === '0',
    codecs,
  };
}
