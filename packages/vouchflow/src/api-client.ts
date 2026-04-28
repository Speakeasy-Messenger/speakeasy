import { DeviceReputation, VouchflowValidationError } from './types.js';

const API_VERSION = '2026-04-01';

export interface VouchflowApiClientOptions {
  baseUrl: string;
  /** Read-scoped API key (vsk_{sandbox,live}_read_…). Never use a write key here. */
  readKey: string;
  /** Override fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override the API version header. */
  apiVersion?: string;
}

/** Thin REST client over the Vouchflow API. */
export class VouchflowApiClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly doFetch: typeof fetch;

  constructor(opts: VouchflowApiClientOptions) {
    if (!opts.baseUrl) throw new Error('VouchflowApiClient: baseUrl required');
    if (!opts.readKey) throw new Error('VouchflowApiClient: readKey required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.headers = {
      Authorization: `Bearer ${opts.readKey}`,
      'Vouchflow-API-Version': opts.apiVersion ?? API_VERSION,
      Accept: 'application/json',
    };
    const f = opts.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('No fetch implementation available');
    this.doFetch = f.bind(globalThis);
  }

  /**
   * Fetch device reputation including the most recent verification.
   * Errors are mapped to VouchflowValidationError so callers can switch on
   * `.reason` without inspecting HTTP status codes.
   */
  async getDeviceReputation(deviceToken: string): Promise<DeviceReputation> {
    if (!deviceToken || typeof deviceToken !== 'string') {
      throw new VouchflowValidationError('malformed', 'empty deviceToken');
    }
    const url = `${this.baseUrl}/device/${encodeURIComponent(deviceToken)}/reputation`;

    let res: Response;
    try {
      res = await this.doFetch(url, { method: 'GET', headers: this.headers });
    } catch (err) {
      throw new VouchflowValidationError(
        'network_error',
        err instanceof Error ? err.message : String(err),
      );
    }

    if (res.status === 200) {
      return (await res.json()) as DeviceReputation;
    }

    const reason = (() => {
      switch (res.status) {
        case 401:
          return 'unauthorized' as const;
        case 403:
          return 'forbidden' as const;
        case 404:
          return 'device_not_found' as const;
        case 429:
          return 'rate_limited' as const;
        default:
          return 'network_error' as const;
      }
    })();
    throw new VouchflowValidationError(reason, `vouchflow ${res.status}`);
  }
}
