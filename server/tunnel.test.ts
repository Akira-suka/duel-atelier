import { describe, expect, it } from 'vitest';
import { quickTunnelOrigin } from './tunnel';

describe('temporary public origin', () => {
  it('extracts the exact HTTPS hostname, not other URLs or spoofed suffixes', () => {
    expect(quickTunnelOrigin('| https://a-b-c.trycloudflare.com |')).toBe('https://a-b-c.trycloudflare.com');
    expect(quickTunnelOrigin('https://a.trycloudflare.com.evil.example')).toBeNull();
    expect(quickTunnelOrigin('http://a.trycloudflare.com')).toBeNull();
    expect(quickTunnelOrigin('https://evil.example')).toBeNull();
  });
});
