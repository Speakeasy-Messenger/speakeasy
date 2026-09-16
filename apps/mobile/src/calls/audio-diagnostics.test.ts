import { describe, expect, it } from 'vitest';
import {
  detectInboundAudioDead,
  summarizeAudioPeer,
  summarizeAudioSdp,
} from './audio-diagnostics.js';

describe('audio diagnostics privacy and counters', () => {
  it('reports cumulative RTP counters and deltas with hashed correlation ids', () => {
    const reports = [
      { id: 'codec-secret', type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { id: 'out-secret', type: 'outbound-rtp', kind: 'audio', ssrc: 123456, packetsSent: 12, bytesSent: 400, codecId: 'codec-secret' },
      { id: 'in-secret', type: 'inbound-rtp', kind: 'audio', ssrc: 654321, packetsReceived: 9, bytesReceived: 300, codecId: 'codec-secret' },
    ];
    const first = summarizeAudioPeer(reports, {}, undefined, 1_000);
    const second = summarizeAudioPeer(
      reports.map((r) => r.type === 'outbound-rtp' ? { ...r, packetsSent: 15, bytesSent: 460 } : r),
      {},
      first.counters,
      3_000,
    );
    const json = JSON.stringify(second.snapshot);
    expect(json).not.toContain('123456');
    expect(json).not.toContain('654321');
    expect(json).not.toContain('codec-secret');
    expect((second.snapshot.outbound as any[])[0]).toMatchObject({
      packetsSent: 15,
      packetsSentDelta: 3,
      bytesSentDelta: 60,
      codec: { name: 'opus', clockRate: 48000, channels: 2 },
    });
  });

  it('keeps unsupported metrics explicit rather than fabricating zero', () => {
    const { snapshot } = summarizeAudioPeer(
      [{ id: 'out', type: 'outbound-rtp', mediaType: 'audio' }],
      {},
      undefined,
      100,
    );
    expect((snapshot.outbound as any[])[0]).toMatchObject({
      packetsSent: null,
      packetsSentDelta: null,
      bytesSent: null,
      bytesSentDelta: null,
      audioLevel: null,
      active: null,
      codec: null,
    });
  });

  it('summarizes only sanitized audio negotiation metadata', () => {
    const sdp = [
      'v=0',
      'o=- 123 456 IN IP4 203.0.113.10',
      'a=ice-ufrag:secret-user-fragment',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'c=IN IP4 198.51.100.2',
      'a=sendrecv',
      'a=rtpmap:111 opus/48000/2',
      'a=candidate:raw-private-candidate',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
    ].join('\r\n');
    const summary = summarizeAudioSdp(sdp);
    expect(summary).toEqual({
      present: true,
      port: 9,
      protocol: 'UDP/TLS/RTP/SAVPF',
      direction: 'sendrecv',
      rejected: false,
      codecs: [{ name: 'opus', clockRate: 48000, channels: 2 }],
    });
    const json = JSON.stringify(summary);
    expect(json).not.toContain('203.0.113.10');
    expect(json).not.toContain('secret-user-fragment');
    expect(json).not.toContain('candidate');
  });
});

describe('detectInboundAudioDead (call-01M2N41QF1P7BE6HSWR152SMRG breadcrumb)', () => {
  const reports = (audio: { sent: number; recv: number }, video: { recv: number }) => [
    { type: 'outbound-rtp', kind: 'audio', packetsSent: audio.sent, bytesSent: audio.sent * 30 },
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: audio.recv, bytesReceived: audio.recv * 30 },
    { type: 'inbound-rtp', kind: 'video', packetsReceived: video.recv, bytesReceived: video.recv * 1200 },
  ];

  it('flags dead inbound audio while inbound video flows (BUNDLE asymmetry)', () => {
    const d = detectInboundAudioDead(reports({ sent: 50, recv: 0 }, { recv: 900 }), 12_000);
    expect(d).not.toBeNull();
    // Same-transport asymmetry: video flowing while audio isn't points at
    // the peer's audio sender, not the network path.
    expect(d).toMatchObject({
      connectedElapsedMs: 12_000,
      outboundAudioPacketsSent: 50,
      inboundAudioPacketsReceived: 0,
      inboundVideoPacketsReceived: 900,
      inboundVideoFlowing: true,
    });
  });

  it('stays silent before the grace window elapses', () => {
    expect(detectInboundAudioDead(reports({ sent: 50, recv: 0 }, { recv: 900 }), 9_000)).toBeNull();
  });

  it('stays silent while we ourselves sent no outbound audio (sender-side mute is a different failure)', () => {
    expect(detectInboundAudioDead(reports({ sent: 0, recv: 0 }, { recv: 0 }), 30_000)).toBeNull();
  });

  it('stays silent when inbound audio is actually flowing', () => {
    expect(detectInboundAudioDead(reports({ sent: 50, recv: 40 }, { recv: 900 }), 30_000)).toBeNull();
  });

  it('handles missing report kinds without crashing', () => {
    expect(detectInboundAudioDead([{ type: 'outbound-rtp', kind: 'audio', packetsSent: 10 }], 30_000)).not.toBeNull();
    expect(detectInboundAudioDead([], 30_000)).toBeNull();
  });
});
