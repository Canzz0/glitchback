/**
 * Picks the client address used for rate limiting.
 *
 * Each proxy appends the address it saw to X-Forwarded-For, so only the last
 * `trustedHops` entries were written by infrastructure you control. Anything to
 * their left came from the client and can be forged. With 0 hops the header is
 * ignored and the TCP peer address is used.
 */
export function clientIp(forwardedFor: string | undefined, socketAddress: string | undefined, trustedHops: number): string {
  if (trustedHops > 0 && forwardedFor) {
    const chain = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
    const ip = chain[chain.length - trustedHops];
    if (ip) return ip;
  }
  return socketAddress || "unknown";
}
