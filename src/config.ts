import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load a local .env file when present (Node >= 20.12). In production, set real
// environment variables instead.
if (existsSync(resolve(process.cwd(), '.env')) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function listFromEnv(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface ServerConfig {
  port: number;
  /** Empty array = allow any origin (development only). */
  allowedOrigins: string[];
  /** Trust X-Forwarded-For when running behind a reverse proxy. */
  trustProxy: boolean;
  maxParticipants: number;
  roomMaxAgeMs: number;
  /** How long an empty room is kept so someone can come back to it. */
  emptyRoomTtlMs: number;
  /** How long a seat is held after a WebSocket drops. */
  reconnectGraceMs: number;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret: string | null;
  turnTtlSeconds: number;
  staticDir: string | null;
}

export const config: ServerConfig = {
  port: intFromEnv('PORT', 3000, 1, 65535),
  allowedOrigins: listFromEnv('ALLOWED_ORIGINS'),
  trustProxy: process.env['TRUST_PROXY'] === '1' || process.env['TRUST_PROXY'] === 'true',
  maxParticipants: intFromEnv('MAX_PARTICIPANTS', 6, 2, 12),
  roomMaxAgeMs: intFromEnv('ROOM_MAX_AGE_HOURS', 12, 1, 72) * 60 * 60 * 1000,
  emptyRoomTtlMs: 60_000,
  reconnectGraceMs: 15_000,
  stunUrls: listFromEnv('STUN_URLS', ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']),
  turnUrls: listFromEnv('TURN_URLS'),
  turnSecret: process.env['TURN_SECRET'] || null,
  turnTtlSeconds: intFromEnv('TURN_TTL_SECONDS', 6 * 60 * 60, 300, 24 * 60 * 60),
  staticDir: process.env['STATIC_DIR'] ? resolve(process.cwd(), process.env['STATIC_DIR']) : null,
};
