/**
 * Security service — PIN hashing (scrypt) and WebAuthn credential management.
 *
 * PIN storage uses scrypt (memory-hard, like Argon2) with a random salt,
 * stored in IndexedDB via the vault's meta store. WebAuthn credentials are
 * persisted alongside so the wallet can offer platform-authenticator unlock
 * as a faster alternative to passphrase re-entry.
 *
 * All operations are available from extension window contexts (popup, options,
 * side panel). The background service worker must relay these calls.
 */

import { scryptAsync } from '@noble/hashes/scrypt';
import { randomBytes, hexToBytes } from '@noble/hashes/utils';
import { readMeta, writeMeta } from '@/core/vault/storage';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'security:settings';
const SCRYPT_OPTIONS = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecuritySettings {
  /** Hex-encoded scrypt hash of the PIN. Null if PIN is not set up. */
  pinHash: string | null;
  /** Hex-encoded random salt used for PIN hashing. */
  pinSalt: string | null;
  /** Base64-encoded WebAuthn credential ID. */
  webauthnCredentialId: string | null;
  /** Base64-encoded WebAuthn credential public key (raw COSE key). */
  webauthnPublicKey: string | null;
  /** Whether WebAuthn unlock is enabled on this device. */
  webauthnEnabled: boolean;
  /** Consecutive failed PIN attempts (drives the brute-force lockout). */
  pinFailedAttempts: number;
  /** Epoch ms until which PIN verification is locked out, or null. */
  pinLockedUntil: number | null;
}

/** Public-facing security status (no secret material). */
export interface SecurityStatus {
  pinEnabled: boolean;
  webauthnEnabled: boolean;
}

// ---------------------------------------------------------------------------
// PIN hashing
// ---------------------------------------------------------------------------

/**
 * Hashes a PIN with scrypt using the given salt.
 * If no salt is provided, a new random one is generated.
 */
export async function hashPin(
  pin: string,
  existingSalt?: string,
): Promise<{ hash: string; salt: string }> {
  const salt = existingSalt ?? bytesToHex(randomBytes(16));
  const password = new Uint8Array(new TextEncoder().encode(pin));
  const hash = await scryptAsync(password, new Uint8Array(hexToBytes(salt)), SCRYPT_OPTIONS);
  return { hash: bytesToHex(hash), salt };
}

/**
 * Verifies a PIN against a stored hash/salt.
 * Constant-time comparison to prevent timing attacks.
 */
export async function verifyPin(
  pin: string,
  storedHash: string,
  storedSalt: string,
): Promise<boolean> {
  const { hash } = await hashPin(pin, storedSalt);
  return constantTimeEqual(hash, storedHash);
}

// ---------------------------------------------------------------------------
// WebAuthn
// ---------------------------------------------------------------------------

/**
 * Registers a new WebAuthn credential (passkey).
 *
 * @param challenge - Random challenge from the RP.
 * @returns The credential ID and raw public key, or null if the user cancelled.
 */
export async function registerWebAuthn(
  challenge: Uint8Array,
  rpName = 'Veilpay',
  rpId = window.location.hostname,
): Promise<{ credentialId: string; publicKey: string } | null> {
  if (!navigator.credentials || !navigator.credentials.create) {
    console.warn('[veilpay] WebAuthn not available in this context.');
    return null;
  }

  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: new Uint8Array(challenge) as BufferSource,
        rp: { name: rpName, id: rpId },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'veilpay-user',
          displayName: 'Veilpay User',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256 (P-256)
          { type: 'public-key', alg: -257 },  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'required',
        },
        timeout: 60_000,
      },
    }) as PublicKeyCredential | null;

    if (!credential) return null;

    const response = credential.response as AuthenticatorAttestationResponse;
    const credentialId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
    const publicKey = bytesToHex(new Uint8Array(response.getPublicKey() ?? response.getPublicKey() ?? new Uint8Array(0)));
    return { credentialId, publicKey };
  } catch (cause) {
    console.warn('[veilpay] WebAuthn registration failed:', cause);
    return null;
  }
}

/**
 * Authenticates with a registered WebAuthn credential.
 *
 * @returns True if the user verified successfully.
 */
export async function authenticateWebAuthn(
  credentialId: string,
  challenge: Uint8Array,
  _rpId = window.location.hostname,
): Promise<boolean> {
  if (!navigator.credentials || !navigator.credentials.get) {
    console.warn('[veilpay] WebAuthn not available in this context.');
    return false;
  }

  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: new Uint8Array(challenge),
        allowCredentials: [
          {
            type: 'public-key',
            id: new Uint8Array(Uint8Array.from(atob(credentialId), (c) => c.charCodeAt(0))),
            transports: ['internal'],
          },
        ],
        userVerification: 'required',
        timeout: 60_000,
      },
    });

    return credential !== null;
  } catch (cause) {
    console.warn('[veilpay] WebAuthn authentication failed:', cause);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: SecuritySettings = {
  pinHash: null,
  pinSalt: null,
  webauthnCredentialId: null,
  webauthnPublicKey: null,
  webauthnEnabled: false,
  pinFailedAttempts: 0,
  pinLockedUntil: null,
};

function isSettings(value: unknown): value is SecuritySettings {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  // Pin fields may be null (unset) but must never be present-but-undefined:
  // `pinHash !== null` is the "PIN configured" check, so an undefined value
  // would silently flip that decision.
  for (const key of ['pinHash', 'pinSalt', 'webauthnCredentialId', 'webauthnPublicKey']) {
    const v = candidate[key];
    if (v !== null && typeof v !== 'string') return false;
  }
  if (typeof candidate.webauthnEnabled !== 'boolean') return false;
  // The throttle fields were added later — older records lack them, so they
  // may be absent (defaults fill in) but must be well-typed when present.
  const attempts = candidate.pinFailedAttempts;
  if (attempts !== undefined && (typeof attempts !== 'number' || attempts < 0)) return false;
  const lockedUntil = candidate.pinLockedUntil;
  if (lockedUntil !== undefined && lockedUntil !== null && typeof lockedUntil !== 'number') {
    return false;
  }
  return true;
}

/**
 * Reads the current security settings from IndexedDB.
 * Malformed/partial rows fall back to the defaults rather than propagating.
 */
export async function readSettings(): Promise<SecuritySettings> {
  const stored = await readMeta<unknown>(STORAGE_KEY);
  // Defaults first: records written before the throttle fields existed lack
  // them, and the merge fills them without a migration.
  return isSettings(stored) ? { ...DEFAULT_SETTINGS, ...stored } : { ...DEFAULT_SETTINGS };
}

/**
 * Writes security settings to IndexedDB.
 */
async function writeSettings(settings: SecuritySettings): Promise<void> {
  await writeMeta(STORAGE_KEY, settings);
}

/**
 * Returns the public-facing security status (no secrets).
 */
export async function getSecurityStatus(): Promise<SecurityStatus> {
  const settings = await readSettings();
  return {
    pinEnabled: settings.pinHash !== null,
    webauthnEnabled: settings.webauthnEnabled,
  };
}

/**
 * Starts a WebAuthn authentication ceremony: returns the registered credential
 * id and a fresh random challenge for the UI to present to the authenticator.
 * Returns null when no passkey is registered. The credential id is a public
 * handle (not secret); the challenge is single-use by convention.
 */
export async function getWebAuthnChallenge(): Promise<{
  credentialId: string;
  challenge: Uint8Array;
} | null> {
  const settings = await readSettings();
  if (!settings.webauthnEnabled || settings.webauthnCredentialId === null) {
    return null;
  }
  return {
    credentialId: settings.webauthnCredentialId,
    challenge: crypto.getRandomValues(new Uint8Array(32)),
  };
}

/**
 * Sets up a PIN. If the PIN was already set, this updates it.
 */
export async function setupPin(pin: string): Promise<{ ok: boolean }> {
  if (pin.length < 4 || pin.length > 128) {
    return { ok: false };
  }
  const { hash, salt } = await hashPin(pin);
  const settings = await readSettings();
  settings.pinHash = hash;
  settings.pinSalt = salt;
  await writeSettings(settings);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// PIN brute-force throttle
// ---------------------------------------------------------------------------
//
// scrypt (N=2^17) already makes each guess cost ~0.5–1 s, but a 4-digit PIN is
// still only 10k candidates — hours of scripted attempts with no other control.
// After PIN_FAST_ATTEMPTS free failures, every further failure doubles a
// lockout window (30 s, 60 s, 120 s, … capped at 5 min). The counter is
// persisted, so reloading the extension or restarting the service worker does
// not reset it. A successful verification clears the counter.
// ---------------------------------------------------------------------------

const PIN_FAST_ATTEMPTS = 5;
const PIN_BASE_LOCKOUT_MS = 30_000;
const PIN_MAX_LOCKOUT_MS = 5 * 60_000;

/**
 * Verifies a PIN against the stored hash, throttled against brute force.
 * When locked out, returns `ok: false` with `retryAfterMs` set — the PIN is
 * NOT evaluated in that state (a correct PIN waits like any other attempt).
 */
export async function verifyUserPin(
  pin: string,
): Promise<{ ok: boolean; retryAfterMs?: number }> {
  const settings = await readSettings();
  if (settings.pinHash === null || settings.pinSalt === null) {
    return { ok: false };
  }

  const now = Date.now();
  if (settings.pinLockedUntil !== null && now < settings.pinLockedUntil) {
    return { ok: false, retryAfterMs: settings.pinLockedUntil - now };
  }

  const valid = await verifyPin(pin, settings.pinHash, settings.pinSalt);
  if (valid) {
    if (settings.pinFailedAttempts > 0 || settings.pinLockedUntil !== null) {
      await writeSettings({ ...settings, pinFailedAttempts: 0, pinLockedUntil: null });
    }
    return { ok: true };
  }

  const failures = settings.pinFailedAttempts + 1;
  let lockedUntil: number | null = null;
  if (failures > PIN_FAST_ATTEMPTS) {
    const backoff = Math.min(
      PIN_BASE_LOCKOUT_MS * 2 ** (failures - PIN_FAST_ATTEMPTS - 1),
      PIN_MAX_LOCKOUT_MS,
    );
    lockedUntil = now + backoff;
  }
  await writeSettings({ ...settings, pinFailedAttempts: failures, pinLockedUntil: lockedUntil });
  return {
    ok: false,
    ...(lockedUntil !== null ? { retryAfterMs: lockedUntil - now } : {}),
  };
}

/**
 * Registers a WebAuthn credential and enables WebAuthn unlock.
 */
export async function setupWebAuthn(): Promise<{ ok: boolean }> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const result = await registerWebAuthn(challenge);
  if (result === null) {
    return { ok: false };
  }
  const settings = await readSettings();
  settings.webauthnCredentialId = result.credentialId;
  settings.webauthnPublicKey = result.publicKey;
  settings.webauthnEnabled = true;
  await writeSettings(settings);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Constant-time string comparison to prevent timing attacks on PIN verification.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Hash outputs are always the same length, so a length mismatch is a
    // programming error, not a timing attack. But we still drain the same
    // cycles to avoid introducing a side-channel.
    let result = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      result |= (a.charCodeAt(Math.min(i, a.length - 1)) ?? 0) ^ (b.charCodeAt(Math.min(i, b.length - 1)) ?? 0);
    }
    return result === 0;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}