/**
 * Server-clock estimation: ping/pong offset samples, median-filtered.
 * Used only to agree on the race start moment and to pace the local sim —
 * never inside the simulation itself.
 */
export class ClockSync {
  private offsets: number[] = [];
  rttMs = 0;

  onPong(pt: number, serverNow: number): void {
    const now = Date.now();
    const rtt = now - pt;
    if (rtt < 0 || rtt > 5000) return;
    this.rttMs = rtt;
    const offset = serverNow + rtt / 2 - now;
    this.offsets.push(offset);
    if (this.offsets.length > 9) this.offsets.shift();
  }

  private medianOffset(): number {
    if (this.offsets.length === 0) return 0;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  /** Estimated current time on the server's Date.now() clock. */
  serverNow(): number {
    return Date.now() + this.medianOffset();
  }
}
