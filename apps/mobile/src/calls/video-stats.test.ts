import { describe, expect, it } from 'vitest';
import { summarizeVideoStats } from './video-stats.js';

describe('summarizeVideoStats', () => {
  it('aggregates local inbound and outbound video counters', () => {
    expect(
      summarizeVideoStats([
        {
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 100,
          framesDecoded: 7,
          framesDropped: 2,
          freezeCount: 1,
          frameWidth: 720,
          frameHeight: 1280,
        },
        {
          type: 'inbound-rtp',
          mediaType: 'video',
          bytesReceived: 50,
          framesReceived: 3,
          frameWidth: 360,
          frameHeight: 640,
        },
        {
          type: 'outbound-rtp',
          kind: 'video',
          bytesSent: 200,
          framesEncoded: 9,
          frameWidth: 1280,
          frameHeight: 720,
        },
      ]),
    ).toEqual({
      inboundBytes: 150,
      inboundFrames: 10,
      inboundDropped: 2,
      inboundFreezes: 1,
      outboundBytes: 200,
      outboundFrames: 9,
      inboundWidth: 720,
      inboundHeight: 1280,
      outboundWidth: 1280,
      outboundHeight: 720,
    });
  });

  it('ignores audio, remote reports, and invalid numeric values', () => {
    expect(
      summarizeVideoStats([
        { type: 'inbound-rtp', kind: 'audio', bytesReceived: 100 },
        { type: 'outbound-rtp', kind: 'video', isRemote: true, bytesSent: 100 },
        { type: 'inbound-rtp', kind: 'video', bytesReceived: 'bad', framesDecoded: NaN },
      ]),
    ).toEqual({
      inboundBytes: 0,
      inboundFrames: 0,
      inboundDropped: 0,
      inboundFreezes: 0,
      outboundBytes: 0,
      outboundFrames: 0,
      inboundWidth: 0,
      inboundHeight: 0,
      outboundWidth: 0,
      outboundHeight: 0,
    });
  });
});
