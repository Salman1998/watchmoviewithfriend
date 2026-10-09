/**
 * Wire protocol shared by the signaling server and the Angular client.
 *
 * IMPORTANT: this file is duplicated verbatim in
 *   client/src/app/core/models/protocol.ts
 * Keep the two copies identical when you change the protocol.
 *
 * Every WebSocket frame is a single JSON object with a `type` discriminator.
 * Media never travels over this channel - only signaling and small events.
 */

// ---------------------------------------------------------------------------
// Shared data shapes
// ---------------------------------------------------------------------------

/** WebSocket-level reachability of a participant, as seen by the server. */
export type ParticipantConnection = 'connected' | 'reconnecting';

/**
 * IDs of the two outgoing MediaStreams a client may publish. They are announced
 * up front so receivers can tell "this is a voice" from "this is the movie"
 * without guessing from track kinds.
 */
export interface StreamIds {
  mic: string;
  screen: string;
}

export interface Participant {
  id: string;
  name: string;
  /** Epoch milliseconds. Also decides who becomes host next (oldest first). */
  joinedAt: number;
  /** True when the microphone is muted OR unavailable. */
  micMuted: boolean;
  /** False when the person has no microphone or denied permission. */
  micAvailable: boolean;
  connection: ParticipantConnection;
  streams: StreamIds;
}

export interface ScreenShareState {
  /** Participant currently sharing (always the host). */
  hostId: string;
  /** Whether tab/system audio was captured together with the picture. */
  hasAudio: boolean;
  startedAt: number;
}

export interface RoomSnapshot {
  id: string;
  createdAt: number;
  hostId: string;
  maxParticipants: number;
  participants: Participant[];
  screenShare: ScreenShareState | null;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

/** Mirrors the browser's RTCIceServer, kept local so the server needs no DOM types. */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Mirrors RTCSessionDescriptionInit. */
export interface SessionDescriptionPayload {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

/** Mirrors RTCIceCandidateInit. */
export interface IceCandidatePayload {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** One WebRTC signaling payload: either a description or an ICE candidate. */
export interface SignalData {
  description?: SessionDescriptionPayload;
  /** `null` means "end of candidates". */
  candidate?: IceCandidatePayload | null;
}

export type ErrorCode =
  | 'invalid-message'
  | 'invalid-name'
  | 'invalid-room'
  | 'room-not-found'
  | 'room-expired'
  | 'room-full'
  | 'not-in-room'
  | 'already-in-room'
  | 'not-host'
  | 'rate-limited'
  | 'server-error';

export type LeaveReason = 'left' | 'kicked' | 'timeout';
export type RoomClosedReason = 'ended-by-host' | 'expired';

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'create-room'; name: string; streams: StreamIds }
  | {
      type: 'join-room';
      roomId: string;
      name: string;
      streams: StreamIds;
      /** Present when rejoining after a dropped connection. */
      resumeToken?: string;
    }
  | { type: 'leave' }
  | { type: 'chat'; text: string }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'mic-state'; muted: boolean; available: boolean }
  | { type: 'speaking'; speaking: boolean }
  | { type: 'screen-share-start'; hasAudio: boolean }
  | { type: 'screen-share-stop' }
  | { type: 'kick'; participantId: string }
  | { type: 'end-room' }
  | { type: 'ping' };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | {
      type: 'joined';
      selfId: string;
      /** Secret that lets this client reclaim its seat after a network blip. */
      resumeToken: string;
      room: RoomSnapshot;
      iceServers: IceServerConfig[];
    }
  | {
      type: 'participant-joined';
      participant: Participant;
      /** Set when this is a known person reconnecting under a new id. */
      replacesId?: string;
    }
  | { type: 'participant-left'; participantId: string; reason: LeaveReason }
  | { type: 'participant-updated'; participant: Participant }
  | { type: 'host-changed'; hostId: string }
  | { type: 'screen-share'; screenShare: ScreenShareState | null }
  | { type: 'speaking'; participantId: string; speaking: boolean }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'kicked' }
  | { type: 'room-closed'; reason: RoomClosedReason }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'pong' };

export type ServerMessageType = ServerMessage['type'];
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;

// ---------------------------------------------------------------------------
// Limits shared by both sides
// ---------------------------------------------------------------------------

export const ROOM_ID_LENGTH = 6;
/** No 0/O/1/I/L so codes are easy to read aloud and type. */
export const ROOM_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const MAX_NAME_LENGTH = 24;
export const MAX_CHAT_LENGTH = 500;
