import { createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, type RawData, type WebSocketServer } from 'ws';
import type { ServerConfig } from './config.js';
import type {
  ClientMessage,
  ErrorCode,
  IceServerConfig,
  LeaveReason,
  ServerMessage,
} from './models/protocol.js';
import type { ParticipantRecord, RoomRecord } from './models/room.js';
import { RoomManager, toPublicParticipant } from './room-manager.js';
import { normalizeRoomId, parseClientMessage, sanitizeChatText, sanitizeName } from './validation.js';

/** Simple token bucket used to rate-limit a single connection. */
class TokenBucket {
  private tokens: number;
  private updatedAt = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updatedAt) / 1000) * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Per-WebSocket state. A session may or may not currently be seated in a room. */
interface Session {
  socket: WebSocket;
  ip: string;
  isAlive: boolean;
  roomId: string | null;
  participantId: string | null;
  /** All messages. Generous, because ICE candidates arrive in bursts. */
  messageBucket: TokenBucket;
  chatBucket: TokenBucket;
}

const ERROR_TEXT: Record<ErrorCode, string> = {
  'invalid-message': 'That request could not be understood.',
  'invalid-name': 'Enter a display name between 1 and 24 characters.',
  'invalid-room': 'Room codes are 6 letters and numbers.',
  'room-not-found': 'No room matches that code. Check it and try again.',
  'room-expired': 'That room has ended. Ask your host for a new link.',
  'room-full': 'That room is full.',
  'not-in-room': 'You are not in a room.',
  'already-in-room': 'You are already in a room.',
  'not-host': 'Only the host can do that.',
  'rate-limited': 'Too many attempts. Wait a moment and try again.',
  'server-error': 'Something went wrong on the server.',
};

const HEARTBEAT_INTERVAL_MS = 30_000;
const SWEEP_INTERVAL_MS = 30_000;
/** Failed join attempts allowed per IP per minute (slows down code guessing). */
const MAX_JOIN_FAILURES_PER_MINUTE = 15;

/**
 * Translates WebSocket traffic into RoomManager operations and fans the
 * results back out. It relays WebRTC offers/answers/candidates between peers
 * but never sees a single byte of audio or video.
 */
export class SignalingServer {
  private readonly sessions = new Set<Session>();
  /** participantId -> live session. */
  private readonly seats = new Map<string, Session>();
  /** participantId -> timer that frees the seat if they don't come back. */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly joinFailures = new Map<string, { count: number; resetAt: number }>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly wss: WebSocketServer,
    private readonly rooms: RoomManager,
    private readonly config: ServerConfig,
  ) {
    this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.heartbeat = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
    this.sweeper = setInterval(() => this.sweepRooms(), SWEEP_INTERVAL_MS);
  }

  get connectionCount(): number {
    return this.sessions.size;
  }

  shutdown(): void {
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    for (const session of this.sessions) session.socket.close(1001, 'Server shutting down');
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const session: Session = {
      socket,
      ip: this.clientIp(request),
      isAlive: true,
      roomId: null,
      participantId: null,
      messageBucket: new TokenBucket(120, 40),
      chatBucket: new TokenBucket(5, 1),
    };
    this.sessions.add(session);

    socket.on('pong', () => (session.isAlive = true));
    socket.on('message', (data, isBinary) => this.handleRawMessage(session, data, isBinary));
    socket.on('close', () => this.handleDisconnect(session));
    socket.on('error', (error) => console.warn('[ws] socket error:', error.message));
  }

  private handleRawMessage(session: Session, data: RawData, isBinary: boolean): void {
    if (isBinary) return this.sendError(session, 'invalid-message');
    if (!session.messageBucket.take()) return this.sendError(session, 'rate-limited');

    const message = parseClientMessage(data.toString());
    if (!message) return this.sendError(session, 'invalid-message');

    try {
      this.dispatch(session, message);
    } catch (error) {
      console.error('[signaling] failed to handle message', message.type, error);
      this.sendError(session, 'server-error');
    }
  }

  /** The socket closed without an explicit "leave": hold the seat for a while. */
  private handleDisconnect(session: Session): void {
    this.sessions.delete(session);
    const seated = this.seatOf(session);
    if (!seated) return;

    const { room, participant } = seated;
    this.seats.delete(participant.id);
    session.roomId = null;
    session.participantId = null;

    participant.connection = 'reconnecting';
    this.broadcast(room, { type: 'participant-updated', participant: toPublicParticipant(participant) });
    this.broadcast(room, { type: 'speaking', participantId: participant.id, speaking: false });

    const timer = setTimeout(() => {
      this.graceTimers.delete(participant.id);
      this.removeFromRoom(room.id, participant.id, 'timeout');
    }, this.config.reconnectGraceMs);
    this.graceTimers.set(participant.id, timer);
  }

  private checkHeartbeats(): void {
    for (const session of this.sessions) {
      if (!session.isAlive) {
        session.socket.terminate(); // triggers 'close' -> handleDisconnect
        continue;
      }
      session.isAlive = false;
      session.socket.ping();
    }
  }

  private sweepRooms(): void {
    for (const { room, reason } of this.rooms.sweep()) {
      this.evictEveryone(room, { type: 'room-closed', reason });
    }
    const now = Date.now();
    for (const [ip, entry] of this.joinFailures) {
      if (entry.resetAt <= now) this.joinFailures.delete(ip);
    }
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private dispatch(session: Session, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        return this.send(session, { type: 'pong' });
      case 'create-room':
        return this.handleCreate(session, message);
      case 'join-room':
        return this.handleJoin(session, message);
      default:
        break;
    }

    // Everything below requires a seat in a room.
    const seated = this.seatOf(session);
    if (!seated) return this.sendError(session, 'not-in-room');
    const { room, participant } = seated;

    switch (message.type) {
      case 'leave':
        this.detach(session);
        this.removeFromRoom(room.id, participant.id, 'left');
        return;

      case 'chat': {
        const text = sanitizeChatText(message.text);
        if (!text) return this.sendError(session, 'invalid-message');
        if (!session.chatBucket.take()) return this.sendError(session, 'rate-limited');
        this.broadcast(room, {
          type: 'chat',
          message: {
            id: randomUUID(),
            senderId: participant.id,
            senderName: participant.name,
            text,
            timestamp: Date.now(),
          },
        });
        return;
      }

      case 'signal': {
        // Relay only between two people seated in the same room. The payload
        // is forwarded untouched; the server never inspects media.
        if (message.to === participant.id || !room.participants.has(message.to)) return;
        const target = this.seats.get(message.to);
        if (target) this.send(target, { type: 'signal', from: participant.id, data: message.data });
        return;
      }

      case 'mic-state':
        participant.micAvailable = message.available;
        participant.micMuted = message.muted || !message.available;
        this.broadcast(room, { type: 'participant-updated', participant: toPublicParticipant(participant) });
        if (participant.micMuted) {
          this.broadcast(room, { type: 'speaking', participantId: participant.id, speaking: false });
        }
        return;

      case 'speaking':
        if (participant.micMuted && message.speaking) return;
        this.broadcast(room, { type: 'speaking', participantId: participant.id, speaking: message.speaking }, participant.id);
        return;

      case 'screen-share-start':
        if (room.hostId !== participant.id) return this.sendError(session, 'not-host');
        this.broadcast(room, {
          type: 'screen-share',
          screenShare: this.rooms.setScreenShare(room, participant.id, message.hasAudio),
        });
        return;

      case 'screen-share-stop':
        if (room.screenShare?.hostId !== participant.id) return;
        room.screenShare = null;
        this.broadcast(room, { type: 'screen-share', screenShare: null });
        return;

      case 'kick': {
        if (room.hostId !== participant.id) return this.sendError(session, 'not-host');
        if (message.participantId === participant.id || !room.participants.has(message.participantId)) return;
        const target = this.seats.get(message.participantId);
        if (target) {
          this.send(target, { type: 'kicked' });
          this.detach(target);
        }
        this.removeFromRoom(room.id, message.participantId, 'kicked');
        return;
      }

      case 'end-room':
        if (room.hostId !== participant.id) return this.sendError(session, 'not-host');
        this.rooms.closeRoom(room.id);
        this.evictEveryone(room, { type: 'room-closed', reason: 'ended-by-host' });
        return;
    }
  }

  private handleCreate(session: Session, message: Extract<ClientMessage, { type: 'create-room' }>): void {
    if (session.participantId) return this.sendError(session, 'already-in-room');
    const name = sanitizeName(message.name);
    if (!name) return this.sendError(session, 'invalid-name');

    const { room, participant } = this.rooms.createRoom(name, message.streams);
    this.seat(session, room, participant);
    this.sendJoined(session, room, participant);
  }

  private handleJoin(session: Session, message: Extract<ClientMessage, { type: 'join-room' }>): void {
    if (session.participantId) return this.sendError(session, 'already-in-room');
    if (this.isJoinBlocked(session.ip)) return this.sendError(session, 'rate-limited');

    const name = sanitizeName(message.name);
    if (!name) return this.sendError(session, 'invalid-name');
    const roomId = normalizeRoomId(message.roomId);
    if (!roomId) {
      this.recordJoinFailure(session.ip);
      return this.sendError(session, 'invalid-room');
    }

    const result = this.rooms.joinRoom(roomId, name, message.streams, message.resumeToken);
    if (!result.ok) {
      if (result.code !== 'room-full') this.recordJoinFailure(session.ip);
      return this.sendError(session, result.code);
    }

    const { room, participant, replaced } = result;

    if (replaced) {
      // The old seat is gone: stop its grace timer and drop any socket that
      // is somehow still attached to it.
      this.clearGraceTimer(replaced.id);
      const stale = this.seats.get(replaced.id);
      if (stale) {
        this.detach(stale);
        stale.socket.close(4000, 'Replaced by a newer connection');
      }
    }

    this.seat(session, room, participant);
    this.sendJoined(session, room, participant);

    this.broadcast(
      room,
      {
        type: 'participant-joined',
        participant: toPublicParticipant(participant),
        ...(replaced ? { replacesId: replaced.id } : {}),
      },
      participant.id,
    );
    if (result.screenShareCleared) {
      this.broadcast(room, { type: 'screen-share', screenShare: null }, participant.id);
    }
    if (result.hostChanged) {
      this.broadcast(room, { type: 'host-changed', hostId: room.hostId }, participant.id);
    }
  }

  // -------------------------------------------------------------------------
  // Room helpers
  // -------------------------------------------------------------------------

  private removeFromRoom(roomId: string, participantId: string, reason: LeaveReason): void {
    this.clearGraceTimer(participantId);
    const result = this.rooms.removeParticipant(roomId, participantId);
    if (!result) return;

    const { room } = result;
    this.broadcast(room, { type: 'participant-left', participantId, reason });
    if (result.screenShareCleared) {
      this.broadcast(room, { type: 'screen-share', screenShare: null });
    }
    if (result.newHostId) {
      this.broadcast(room, { type: 'host-changed', hostId: result.newHostId });
    }
  }

  /** Sends a final message to everyone in a room and frees all their seats. */
  private evictEveryone(room: RoomRecord, message: ServerMessage): void {
    for (const participantId of room.participants.keys()) {
      this.clearGraceTimer(participantId);
      const session = this.seats.get(participantId);
      if (session) {
        this.send(session, message);
        this.detach(session);
      }
    }
    room.participants.clear();
  }

  private seat(session: Session, room: RoomRecord, participant: ParticipantRecord): void {
    session.roomId = room.id;
    session.participantId = participant.id;
    this.seats.set(participant.id, session);
  }

  /** Unlinks a session from its seat without touching room state. */
  private detach(session: Session): void {
    if (session.participantId) this.seats.delete(session.participantId);
    session.roomId = null;
    session.participantId = null;
  }

  private seatOf(session: Session): { room: RoomRecord; participant: ParticipantRecord } | null {
    if (!session.roomId || !session.participantId) return null;
    const room = this.rooms.getRoom(session.roomId);
    const participant = room?.participants.get(session.participantId);
    return room && participant ? { room, participant } : null;
  }

  private clearGraceTimer(participantId: string): void {
    const timer = this.graceTimers.get(participantId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(participantId);
    }
  }

  private sendJoined(session: Session, room: RoomRecord, participant: ParticipantRecord): void {
    this.send(session, {
      type: 'joined',
      selfId: participant.id,
      resumeToken: participant.resumeToken,
      room: this.rooms.snapshot(room),
      iceServers: this.buildIceServers(participant.id),
    });
  }

  // -------------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------------

  private send(session: Session, message: ServerMessage): void {
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify(message));
    }
  }

  private sendError(session: Session, code: ErrorCode): void {
    this.send(session, { type: 'error', code, message: ERROR_TEXT[code] });
  }

  private broadcast(room: RoomRecord, message: ServerMessage, exceptParticipantId?: string): void {
    const payload = JSON.stringify(message);
    for (const participantId of room.participants.keys()) {
      if (participantId === exceptParticipantId) continue;
      const session = this.seats.get(participantId);
      if (session?.socket.readyState === WebSocket.OPEN) session.socket.send(payload);
    }
  }

  /**
   * STUN servers plus, when configured, short-lived TURN credentials using the
   * standard shared-secret scheme (coturn `use-auth-secret`):
   *   username   = "<unix expiry>:<label>"
   *   credential = base64(HMAC-SHA1(secret, username))
   * The long-term secret never leaves the server.
   */
  private buildIceServers(participantId: string): IceServerConfig[] {
    const servers: IceServerConfig[] = [];
    if (this.config.stunUrls.length > 0) servers.push({ urls: this.config.stunUrls });

    if (this.config.turnUrls.length > 0 && this.config.turnSecret) {
      const expiry = Math.floor(Date.now() / 1000) + this.config.turnTtlSeconds;
      const username = `${expiry}:${participantId}`;
      const credential = createHmac('sha1', this.config.turnSecret).update(username).digest('base64');
      servers.push({ urls: this.config.turnUrls, username, credential });
    }
    return servers;
  }

  private clientIp(request: IncomingMessage): string {
    if (this.config.trustProxy) {
      const forwarded = request.headers['x-forwarded-for'];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return request.socket.remoteAddress ?? 'unknown';
  }

  private isJoinBlocked(ip: string): boolean {
    const entry = this.joinFailures.get(ip);
    return !!entry && entry.resetAt > Date.now() && entry.count >= MAX_JOIN_FAILURES_PER_MINUTE;
  }

  private recordJoinFailure(ip: string): void {
    const now = Date.now();
    const entry = this.joinFailures.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.joinFailures.set(ip, { count: 1, resetAt: now + 60_000 });
    } else {
      entry.count += 1;
    }
  }
}
