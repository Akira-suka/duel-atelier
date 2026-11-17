import { io, type Socket } from 'socket.io-client';
import type { Action } from '../game/types';
import type { ClientEvents, EnterRoom, MoveCommand, RoomSnapshot, ServerEvents } from './protocol';

const KEY = 'duel-online-seat-v1';
export interface Credential extends EnterRoom { pending?: MoveCommand }
export interface OnlineState { snapshot: RoomSnapshot | null; connected: boolean; busy: boolean; error: string; saved: boolean }
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export function readCredential(storage: Storage): Credential | null {
  try {
    const value = JSON.parse(storage.getItem(KEY) ?? 'null');
    return value && typeof value.token === 'string' && /^[\w-]{43}$/.test(value.token) ? value : null;
  } catch { return null; }
}

/** One socket and at most one durable in-flight action. No optimistic game-state transitions. */
export class OnlineClient {
  private socket: Socket<ServerEvents, ClientEvents>;
  private credential: Credential | null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private sending = false;
  private epoch = 0;
  state: OnlineState;
  constructor(private readonly changed: (state: OnlineState) => void, private readonly storage: Storage = localStorage, url?: string) {
    this.credential = readCredential(storage);
    this.state = { snapshot: null, connected: false, busy: false, error: '', saved: !!this.credential };
    this.socket = io(url, { transports: ['websocket'], autoConnect: false, reconnectionDelay: 1000, reconnectionDelayMax: 10000 });
    this.socket.on('connect', () => { this.set({ error: '' }); if (this.credential) void this.enter(); else this.set({ connected: true }); });
    this.socket.on('state', snapshot => this.accept(snapshot));
    this.socket.on('disconnect', () => { this.epoch++; this.sending = false; this.set({ connected: false }); });
    this.socket.on('connect_error', () => this.set({ connected: false, error: '连接失败，正在重试；请确认联机服务器已启动。' }));
    this.socket.on('replaced', () => {
      this.stopped = true; clearTimeout(this.retry); this.socket.disconnect();
      this.set({ connected: false, busy: false, error: '此座位已在另一个窗口打开。关闭该窗口后重新连接即可接回。' });
    });
    this.socket.connect();
  }
  private set(patch: Partial<OnlineState>) { this.state = { ...this.state, ...patch }; this.changed(this.state); }
  private save() {
    if (this.credential) this.storage.setItem(KEY, JSON.stringify(this.credential));
    else this.storage.removeItem(KEY);
    this.set({ saved: !!this.credential });
  }
  private accept(snapshot: RoomSnapshot) {
    if (this.state.snapshot && this.state.snapshot.code === snapshot.code && snapshot.view.revision < this.state.snapshot.view.revision) return;
    this.set({ snapshot });
  }
  start(code?: string) {
    if (this.credential || !this.socket.connected) return;
    this.credential = { token: randomToken(), ...(code ? { code: code.trim().toUpperCase() } : {}) };
    try { this.save(); void this.enter(); }
    catch { this.credential = null; this.set({ error: '浏览器无法保存重连凭证，请启用本站存储后再创建房间。' }); }
  }
  private async enter() {
    if (!this.credential || this.stopped) return;
    const epoch = this.epoch;
    this.set({ busy: true });
    try {
      const { token, code } = this.credential;
      const reply = await this.socket.timeout(8000).emitWithAck('enter', { token, ...(code ? { code } : {}) });
      if (this.stopped || epoch !== this.epoch || !this.credential) return;
      if (!reply.ok) { this.set({ error: reply.error, busy: false }); return; }
      this.credential.code = reply.value.code; this.save(); this.accept(reply.value);
      this.set({ connected: true, busy: !!this.credential.pending, error: '' });
      if (this.credential.pending) void this.sendPending();
    } catch {
      if (!this.stopped && epoch === this.epoch) { this.set({ busy: false, error: '入房确认超时，正在重新连接。' }); this.socket.disconnect().connect(); }
    }
  }
  async sync() {
    if (!this.socket.connected || !this.state.snapshot) return;
    const epoch = this.epoch;
    try {
      const reply = await this.socket.timeout(8000).emitWithAck('sync');
      if (this.stopped || epoch !== this.epoch) return;
      if (reply.ok) { this.accept(reply.value); this.set({ error: '' }); } else this.set({ error: reply.error });
    } catch { if (!this.stopped && epoch === this.epoch) this.set({ error: '同步超时，等待连接恢复。' }); }
  }
  move(action: Action) {
    if (!this.credential || !this.state.connected || this.state.busy || !this.state.snapshot) return;
    const id = randomToken().replaceAll('_', 'a').slice(0, 32);
    this.credential.pending = { id, revision: this.state.snapshot.view.revision, action };
    try { this.save(); this.set({ busy: true, error: '' }); void this.sendPending(); }
    catch { delete this.credential.pending; this.set({ error: '无法保存待确认行动，本次没有发送。' }); }
  }
  private async sendPending() {
    if (this.sending || this.stopped || !this.socket.connected || !this.credential?.pending) return;
    const epoch = this.epoch;
    this.sending = true;
    try {
      const reply = await this.socket.timeout(8000).emitWithAck('move', this.credential.pending);
      if (this.stopped || epoch !== this.epoch || !this.credential) return;
      delete this.credential.pending;
      try { this.save(); } catch { /* The server committed; a stale stored request is safe to resend. */ }
      this.set({ busy: false });
      if (reply.ok) { this.accept(reply.value); this.set({ error: '' }); }
      else { await this.sync(); this.set({ error: reply.error }); }
    } catch {
      if (this.stopped || epoch !== this.epoch) return;
      this.set({ error: '行动尚未确认，正在核对；请勿重复操作。' });
      clearTimeout(this.retry); this.retry = setTimeout(() => { void this.sendPending(); }, 3000);
    } finally { if (epoch === this.epoch) this.sending = false; }
  }
  async replay() {
    const reply = await this.socket.timeout(15000).emitWithAck('replay');
    if (!reply.ok) throw Error(reply.error);
    return reply.value;
  }
  credentialFile() { return JSON.stringify({ token: this.credential?.token, code: this.credential?.code }); }
  restore(text: string) {
    const value = JSON.parse(text);
    if (!value || typeof value.token !== 'string' || !/^[\w-]{43}$/.test(value.token) || typeof value.code !== 'string' || !/^[A-HJ-NP-Z2-9]{8}$/.test(value.code)) throw Error('重连凭证无效');
    this.credential = { token: value.token, code: value.code }; this.save(); this.reconnect();
  }
  reconnect() { this.stopped = false; this.socket.disconnect().connect(); }
  forget() {
    clearTimeout(this.retry); this.credential = null; this.save();
    this.set({ snapshot: null, connected: false, busy: false, error: '' }); this.reconnect();
  }
  close() { this.stopped = true; this.epoch++; clearTimeout(this.retry); this.socket.removeAllListeners(); this.socket.disconnect(); }
}
