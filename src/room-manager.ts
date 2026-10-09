import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { ServerConfig } from './config.js';
import {
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  type ErrorCode,
  type Participant,
  type RoomClosedReason,
  type RoomSnapshot,
  type ScreenShareState,
  type StreamIds,
} from './models/protocol.js';
import type { ParticipantRecord, RoomRecord } from './models/room.js';

export type JoinResult =
  | {
      ok: true;
      room: RoomRecord;
      participant: ParticipantRecord;
      /** The stale record this join replaced (reconnect), if any. */
      replaced: ParticipantRecord | null;
      /** True when this join changed who the host is. */
      hostChanged: boolean;
      /** True when an active screen share had to be cleared. */
      screenShareCleared: boolean;
    }
  | { ok: false; code: ErrorCode };

export interface RemovalResult {
  room: RoomRecord;
  removed: ParticipantRecord;
  /** Set when the host role moved to someone else. */
  newHostId: string | null;
  screenShareCleared: boolean;
}

export interface ClosedRoom {
  room: RoomRecord;
  reason: RoomClosedReason;
}

/** How long we remember that a room code used to exist, for nicer errors. */
const TOMBSTONE_TTL_MS = 60 * 60 * 1000;

/**
 * Owns all room state. Pure in-memory bookkeeping: it knows nothing about
 * sockets, so it is easy to reason about and to unit test. Nothing here is
 * persisted - when the process stops, every room is gone.
 */
export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly tombstones = new Map<string, number>();

  constructor(private readonly config: ServerConfig) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  getRoom(roomId: string): RoomRecord | undefined {
    return this.rooms.get(roomId);
  }

  createRoom(name: string, streams: StreamIds): { room: RoomRecord; participant: ParticipantRecord } {
    const now = Date.now();
    const participant = this.newParticipant(name, streams, now);
    const room: RoomRecord = {
      id: this.generateRoomId(),
      createdAt: now,
      hostId: participant.id,
      participants: new Map([[participant.id, participant]]),
      screenShare: null,
      emptySince: null,
    };
    this.rooms.set(room.id, room);
    return { room, participant };
  }

  joinRoom(roomId: string, name: string, streams: StreamIds, resumeToken?: string): JoinResult {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, code: this.tombstones.has(roomId) ? 'room-expired' : 'room-not-found' };
    }

    // A reconnecting client presents the secret token of its previous seat. We
    // give it a brand-new participant id (so every peer rebuilds a clean WebRTC
    // connection) but carry over seniority and the host role.
    const previous = resumeToken ? this.findByResumeToken(room, resumeToken) : undefined;

    const occupied = room.participants.size - (previous ? 1 : 0);
    if (occupied >= this.config.maxParticipants) {
      return { ok: false, code: 'room-full' };
    }

    const participant = this.newParticipant(name, streams, previous?.joinedAt ?? Date.now());
    let hostChanged = false;
    let screenShareCleared = false;

    if (previous) {
      room.participants.delete(previous.id);
      if (room.hostId === previous.id) {
        room.hostId = participant.id;
        hostChanged = true;
      }
      if (room.screenShare?.hostId === previous.id) {
        // The client re-announces its share once its new connections exist.
        room.screenShare = null;
        screenShareCleared = true;
      }
    }

    room.participants.set(participant.id, participant);
    room.emptySince = null;

    if (!room.hostId || !room.participants.has(room.hostId)) {
      room.hostId = participant.id;
      hostChanged = true;
    }

    return { ok: true, room, participant, replaced: previous ?? null, hostChanged, screenShareCleared };
  }

  removeParticipant(roomId: string, participantId: string): RemovalResult | null {
    const room = this.rooms.get(roomId);
    const removed = room?.participants.get(participantId);
    if (!room || !removed) return null;

    room.participants.delete(participantId);

    let screenShareCleared = false;
    if (room.screenShare?.hostId === participantId) {
      room.screenShare = null;
      screenShareCleared = true;
    }

    let newHostId: string | null = null;
    if (room.hostId === participantId) {
      const next = this.pickNextHost(room);
      room.hostId = next?.id ?? '';
      newHostId = next?.id ?? null;
    }

    if (room.participants.size === 0) {
      room.emptySince = Date.now();
    }

    return { room, removed, newHostId, screenShareCleared };
  }

  setScreenShare(room: RoomRecord, hostId: string, hasAudio: boolean): ScreenShareState {
    room.screenShare = { hostId, hasAudio, startedAt: Date.now() };
    return room.screenShare;
  }

  /** Deletes a room immediately (host ended it). */
  closeRoom(roomId: string): void {
    if (this.rooms.delete(roomId)) {
      this.tombstones.set(roomId, Date.now() + TOMBSTONE_TTL_MS);
    }
  }

  /**
   * Periodic cleanup. Returns rooms that were closed while people were still
   * inside so the caller can notify them.
   */
  sweep(now = Date.now()): ClosedRoom[] {
    const closed: ClosedRoom[] = [];

    for (const room of this.rooms.values()) {
      const tooOld = now - room.createdAt > this.config.roomMaxAgeMs;
      const abandoned = room.emptySince !== null && now - room.emptySince > this.config.emptyRoomTtlMs;
      if (!tooOld && !abandoned) continue;

      this.closeRoom(room.id);
      if (room.participants.size > 0) {
        closed.push({ room, reason: 'expired' });
      }
    }

    for (const [roomId, expiresAt] of this.tombstones) {
      if (expiresAt <= now) this.tombstones.delete(roomId);
    }

    return closed;
  }

  snapshot(room: RoomRecord): RoomSnapshot {
    return {
      id: room.id,
      createdAt: room.createdAt,
      hostId: room.hostId,
      maxParticipants: this.config.maxParticipants,
      participants: [...room.participants.values()].map(toPublicParticipant),
      screenShare: room.screenShare,
    };
  }

  // -------------------------------------------------------------------------

  private newParticipant(name: string, streams: StreamIds, joinedAt: number): ParticipantRecord {
    return {
      id: randomUUID(),
      name,
      joinedAt,
      micMuted: true,
      micAvailable: false,
      connection: 'connected',
      streams,
      resumeToken: randomBytes(24).toString('base64url'),
    };
  }

  private findByResumeToken(room: RoomRecord, token: string): ParticipantRecord | undefined {
    for (const participant of room.participants.values()) {
      if (participant.resumeToken === token) return participant;
    }
    return undefined;
  }

  /** Longest-present person who is currently reachable; otherwise anyone. */
  private pickNextHost(room: RoomRecord): ParticipantRecord | undefined {
    const bySeniority = [...room.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    return bySeniority.find((p) => p.connection === 'connected') ?? bySeniority[0];
  }

  private generateRoomId(): string {
    // ~887 million combinations, drawn from a CSPRNG so codes can't be predicted.
    for (;;) {
      let id = '';
      for (let i = 0; i < ROOM_ID_LENGTH; i++) {
        id += ROOM_ID_ALPHABET[randomInt(ROOM_ID_ALPHABET.length)];
      }
      if (!this.rooms.has(id) && !this.tombstones.has(id)) return id;
    }
  }
}

/** Strips server-only fields (the resume token) before anything is broadcast. */
export function toPublicParticipant(record: ParticipantRecord): Participant {
  return {
    id: record.id,
    name: record.name,
    joinedAt: record.joinedAt,
    micMuted: record.micMuted,
    micAvailable: record.micAvailable,
    connection: record.connection,
    streams: record.streams,
  };
}
