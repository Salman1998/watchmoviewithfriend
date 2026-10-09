import type { ParticipantConnection, ScreenShareState, StreamIds } from './protocol.js';

/** Server-side participant. `resumeToken` is secret and never broadcast. */
export interface ParticipantRecord {
  id: string;
  name: string;
  joinedAt: number;
  micMuted: boolean;
  micAvailable: boolean;
  connection: ParticipantConnection;
  streams: StreamIds;
  resumeToken: string;
}

export interface RoomRecord {
  id: string;
  createdAt: number;
  /** Empty string while the room has nobody in it. */
  hostId: string;
  participants: Map<string, ParticipantRecord>;
  screenShare: ScreenShareState | null;
  /** Timestamp when the last person left, or null while occupied. */
  emptySince: number | null;
}
