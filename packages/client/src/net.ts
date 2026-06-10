/**
 * WebSocket wrapper. Every inbound message is Zod-validated before any
 * handler sees it (NFR-16); invalid messages are dropped loudly.
 */
import { parseServerMsg, type ClientMsg, type ServerMsg } from '@mk/shared';

type Handler<T extends ServerMsg['t']> = (msg: Extract<ServerMsg, { t: T }>) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, ((msg: never) => void)[]>();
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private reconnectTimer: number | null = null;
  connected = false;

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      for (const h of this.openHandlers) h();
    };
    ws.onmessage = (ev) => {
      const msg = parseServerMsg(ev.data);
      if (!msg) {
        console.warn('[net] dropped invalid server message', ev.data);
        return;
      }
      const list = this.handlers.get(msg.t);
      if (list) for (const h of list) (h as (m: ServerMsg) => void)(msg);
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
