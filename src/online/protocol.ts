import type { getPlayerView } from '../game/engine';
import type { Action, PlayerId } from '../game/types';

export type PlayerView = ReturnType<typeof getPlayerView>;
export interface RoomSnapshot {
  code: string;
  seat: PlayerId;
  ready: boolean;
  connected: [boolean, boolean];
  view: PlayerView;
  legal: Action[];
}
export interface EnterRoom { token: string; code?: string }
export interface MoveCommand { id: string; revision: number; action: Action }
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export type Ack<T> = (reply: Reply<T>) => void;
export interface ServerEvents { state: (snapshot: RoomSnapshot) => void; replaced: () => void }
export interface ClientEvents {
  enter: (request: EnterRoom, ack: Ack<RoomSnapshot>) => void;
  sync: (ack: Ack<RoomSnapshot>) => void;
  move: (command: MoveCommand, ack: Ack<RoomSnapshot>) => void;
  replay: (ack: Ack<string>) => void;
}
