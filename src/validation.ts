import {
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  type ClientMessage,
  type IceCandidatePayload,
  type SessionDescriptionPayload,
  type SignalData,
  type StreamIds,
} from './models/protocol.js';

/**
 * Every inbound frame is untrusted. These helpers turn raw JSON into a typed
 * ClientMessage or reject it; nothing else in the server reads raw input.
 */

const MAX_SDP_LENGTH = 200_000;
const MAX_CANDIDATE_LENGTH = 2_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** MediaStream ids are UUID-ish; Firefox wraps them in braces. */
const STREAM_ID_PATTERN = /^[A-Za-z0-9_{}-]{1,80}$/;
const ROOM_ID_PATTERN = new RegExp(`^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`);
const SDP_TYPES = new Set(['offer', 'answer', 'pranswer', 'rollback']);

// Control characters, plus zero-width and bidi-override characters that can be
// used to spoof names or scramble chat rendering.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a cleaned display name, or null when it is unusable. */
export function sanitizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0 || cleaned.length > MAX_NAME_LENGTH) return null;
  return cleaned;
}

/**
 * Returns cleaned chat text, or null when empty/too long. HTML is NOT stripped
 * here on purpose: the client renders messages as plain text (Angular escapes
 * interpolations), which is the correct place to neutralise markup.
 */
export function sanitizeChatText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(UNSAFE_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length === 0 || cleaned.length > MAX_CHAT_LENGTH) return null;
  return cleaned;
}

/** Normalises user input ("abc 123" -> "ABC123") and validates it. */
export function normalizeRoomId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\s-]/g, '').toUpperCase();
  return ROOM_ID_PATTERN.test(normalized) ? normalized : null;
}

function parseStreamIds(value: unknown): StreamIds | null {
  if (!isRecord(value)) return null;
  const { mic, screen } = value;
  if (typeof mic !== 'string' || typeof screen !== 'string') return null;
  if (!STREAM_ID_PATTERN.test(mic) || !STREAM_ID_PATTERN.test(screen) || mic === screen) return null;
  return { mic, screen };
}

function parseDescription(value: unknown): SessionDescriptionPayload | null {
  if (!isRecord(value)) return null;
  const { type, sdp } = value;
  if (typeof type !== 'string' || !SDP_TYPES.has(type)) return null;
  if (sdp !== undefined && (typeof sdp !== 'string' || sdp.length > MAX_SDP_LENGTH)) return null;
  return { type: type as SessionDescriptionPayload['type'], ...(sdp !== undefined ? { sdp } : {}) };
}

function parseCandidate(value: unknown): IceCandidatePayload | null {
  if (!isRecord(value)) return null;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = value;
  const out: IceCandidatePayload = {};
  if (candidate !== undefined) {
    if (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE_LENGTH) return null;
    out.candidate = candidate;
  }
  if (sdpMid !== undefined) {
    if (sdpMid !== null && (typeof sdpMid !== 'string' || sdpMid.length > 64)) return null;
    out.sdpMid = sdpMid;
  }
  if (sdpMLineIndex !== undefined) {
    if (sdpMLineIndex !== null && (!Number.isInteger(sdpMLineIndex) || (sdpMLineIndex as number) < 0)) return null;
    out.sdpMLineIndex = sdpMLineIndex as number | null;
  }
  if (usernameFragment !== undefined) {
    if (usernameFragment !== null && (typeof usernameFragment !== 'string' || usernameFragment.length > 256)) return null;
    out.usernameFragment = usernameFragment;
  }
  return out;
}

function parseSignalData(value: unknown): SignalData | null {
  if (!isRecord(value)) return null;
  if (value['description'] !== undefined) {
    const description = parseDescription(value['description']);
    return description ? { description } : null;
  }
  if (value['candidate'] === null) return { candidate: null };
  if (value['candidate'] !== undefined) {
    const candidate = parseCandidate(value['candidate']);
    return candidate ? { candidate } : null;
  }
  return null;
}

/** Parses and validates one WebSocket frame. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json) || typeof json['type'] !== 'string') return null;

  switch (json['type']) {
    case 'create-room': {
      const streams = parseStreamIds(json['streams']);
      if (typeof json['name'] !== 'string' || !streams) return null;
      return { type: 'create-room', name: json['name'], streams };
    }
    case 'join-room': {
      const streams = parseStreamIds(json['streams']);
      if (typeof json['name'] !== 'string' || typeof json['roomId'] !== 'string' || !streams) return null;
      const resumeToken = json['resumeToken'];
      if (resumeToken !== undefined && (typeof resumeToken !== 'string' || !ID_PATTERN.test(resumeToken))) return null;
      return {
        type: 'join-room',
        roomId: json['roomId'].slice(0, 32),
        name: json['name'],
        streams,
        ...(resumeToken !== undefined ? { resumeToken } : {}),
      };
    }
    case 'leave':
    case 'screen-share-stop':
    case 'end-room':
    case 'ping':
      return { type: json['type'] };
    case 'chat':
      return typeof json['text'] === 'string' ? { type: 'chat', text: json['text'] } : null;
    case 'signal': {
      const data = parseSignalData(json['data']);
      if (typeof json['to'] !== 'string' || !ID_PATTERN.test(json['to']) || !data) return null;
      return { type: 'signal', to: json['to'], data };
    }
    case 'mic-state':
      if (typeof json['muted'] !== 'boolean' || typeof json['available'] !== 'boolean') return null;
      return { type: 'mic-state', muted: json['muted'], available: json['available'] };
    case 'speaking':
      return typeof json['speaking'] === 'boolean' ? { type: 'speaking', speaking: json['speaking'] } : null;
    case 'screen-share-start':
      return typeof json['hasAudio'] === 'boolean' ? { type: 'screen-share-start', hasAudio: json['hasAudio'] } : null;
    case 'kick':
      if (typeof json['participantId'] !== 'string' || !ID_PATTERN.test(json['participantId'])) return null;
      return { type: 'kick', participantId: json['participantId'] };
    default:
      return null;
  }
}
