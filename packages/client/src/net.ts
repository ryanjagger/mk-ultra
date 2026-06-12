/**
 * WebSocket wrapper. Every inbound message is Zod-validated before any
 * handler sees it (NFR-16); invalid messages are dropped loudly.
 */
import { parseServerMsg, type ClientMsg, type ServerMsg } from '@mk/shared';

type Handler<T extends ServerMsg['t']> = (msg: Extract<ServerMsg, { t: T }>) => void;

/**
 * Dev-only link simulation (`?lag=90&jitter=30`): adds ~lag ms of RTT
 * (±jitter), split evenly between directions, so production pings are
 * reproducible on localhost — e.g. four `?bot&lag=…` tabs with different
 * values make a real-feeling room on one machine. Two properties matter:
 * delivery is FIFO per direction (TCP never reorders — a delayed message
 * holds back everything behind it, which is exactly real head-of-line
 * blocking), and the pump runs in a Web Worker because hidden tabs throttle
 * window timers to ≥1s, which would distort every backgrounded tab.
 */
class FakeLink {
  private readonly queues: { at: number; fn: () => void }[][] = [[], []];
  private readonly lastAt = [0, 0];

  constructor(
    private readonly halfLagMs: number,
    private readonly halfJitterMs: number,
  ) {
    const worker = new Worker(
      URL.createObjectURL(
        new Blob(['setInterval(() => postMessage(0), 10);'], { type: 'text/javascript' }),
      ),
    );
    worker.onmessage = () => this.drain();
  }

  delay(dir: 0 | 1, fn: () => void): void {
    const jitter = (Math.random() * 2 - 1) * this.halfJitterMs;
    const at = Math.max(
      performance.now() + Math.max(0, this.halfLagMs + jitter),
      this.lastAt[dir]!,
    );
    this.lastAt[dir] = at;
    this.queues[dir]!.push({ at, fn });
  }

  private drain(): void {
    const now = performance.now();
    for (const q of this.queues) {
      while (q.length > 0 && q[0]!.at <= now) q.shift()!.fn();
    }
  }
}

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, ((msg: never) => void)[]>();
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private reconnectTimer: number | null = null;
  private link: FakeLink | null = null;
  connected = false;

  constructor() {
    const q = new URLSearchParams(location.search);
    const lag = Math.max(0, Number(q.get('lag')) || 0);
    const jitter = Math.max(0, Number(q.get('jitter')) || 0);
    if (lag > 0 || jitter > 0) {
      this.link = new FakeLink(lag / 2, jitter / 2);
      console.warn(`[net] link simulation: +${lag}ms RTT ±${jitter}ms jitter`);
    }
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      for (const h of this.openHandlers) h();
    };
    ws.onmessage = (ev) => {
      const deliver = () => {
        const msg = parseServerMsg(ev.data);
        if (!msg) {
          console.warn('[net] dropped invalid server message', ev.data);
          return;
        }
        const list = this.handlers.get(msg.t);
        if (list) for (const h of list) (h as (m: ServerMsg) => void)(msg);
      };
      if (this.link) this.link.delay(0, deliver);
      else deliver();
    };
    ws.onclose = () => {
      this.connected = false;
      for (const h of this.closeHandlers) h();
      this.reconnectTimer = window.setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => ws.close();
  }

  on<T extends ServerMsg['t']>(type: T, handler: Handler<T>): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as (msg: never) => void);
    this.handlers.set(type, list);
  }

  onOpen(h: () => void): void {
    this.openHandlers.push(h);
  }

  onClose(h: () => void): void {
    this.closeHandlers.push(h);
  }

  send(msg: ClientMsg): void {
    if (this.link) this.link.delay(1, () => this.rawSend(msg));
    else this.rawSend(msg);
  }

  /** Socket state is checked at delivery time — it may close mid-delay. */
  private rawSend(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
