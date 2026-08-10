export interface VideoStatsSummary {
  inboundBytes: number;
  inboundFrames: number;
  inboundDropped: number;
  inboundFreezes: number;
  outboundBytes: number;
  outboundFrames: number;
  inboundWidth: number;
  inboundHeight: number;
  outboundWidth: number;
  outboundHeight: number;
}

/** Collapse WebRTC's per-codec/per-SSRC reports into one privacy-safe snapshot. */
export function summarizeVideoStats(reports: readonly Record<string, unknown>[]): VideoStatsSummary {
  const summary: VideoStatsSummary = {
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
  };
  const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

  for (const report of reports) {
    const kind = report.kind ?? report.mediaType;
    if (kind !== 'video' || report.isRemote) continue;
    if (report.type === 'inbound-rtp') {
      summary.inboundBytes += n(report.bytesReceived);
      summary.inboundFrames += n(report.framesDecoded ?? report.framesReceived);
      summary.inboundDropped += n(report.framesDropped);
      summary.inboundFreezes += n(report.freezeCount);
      summary.inboundWidth = Math.max(summary.inboundWidth, n(report.frameWidth));
      summary.inboundHeight = Math.max(summary.inboundHeight, n(report.frameHeight));
    } else if (report.type === 'outbound-rtp') {
      summary.outboundBytes += n(report.bytesSent);
      summary.outboundFrames += n(report.framesEncoded ?? report.framesSent);
      summary.outboundWidth = Math.max(summary.outboundWidth, n(report.frameWidth));
      summary.outboundHeight = Math.max(summary.outboundHeight, n(report.frameHeight));
    }
  }
  return summary;
}
