/**
 * Device identity for the Claw HQ tunnel agent.
 *
 * Generates and persists an Ed25519 keypair. On every connect to the local
 * OpenClaw gateway, the tunnel signs the connect-nonce so the gateway can
 * recognize this device and grant the requested scopes (including
 * operator.admin) without falling through the unbound-scope clearing path.
 *
 * Storage: ~/.claw-hq/device-identity.json (mode 0600). Separate from
 * OpenClaw's own state dir so the two stay isolated.
 *
 * Wire format matches OpenClaw's v3 device-auth payload (see
 * openclaw/dist/client-*.js#buildDeviceAuthPayloadV3 for the canonical
 * implementation we mirror here).
 */
import { promises as fs, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface DeviceIdentity {
  deviceId: string; // sha256 hex of raw 32-byte ed25519 public key
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeyRawBase64Url: string;
  createdAtMs: number;
}

export interface StoredDeviceIdentity {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der",
  }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash("sha256")
    .update(derivePublicKeyRaw(publicKeyPem))
    .digest("hex");
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    publicKeyRawBase64Url: base64UrlEncode(derivePublicKeyRaw(publicKeyPem)),
    createdAtMs: Date.now(),
  };
}

function keyPairMatches(
  publicKeyPem: string,
  privateKeyPem: string,
): boolean {
  try {
    const payload = Buffer.from("claw-hq-device-identity-self-check", "utf8");
    const sig = cryptoSign(null, payload, createPrivateKey(privateKeyPem));
    const verify = require("node:crypto") as typeof import("node:crypto");
    return verify.verify(null, payload, createPublicKey(publicKeyPem), sig);
  } catch {
    return false;
  }
}

export function defaultIdentityPath(): string {
  return resolve(homedir(), ".claw-hq", "device-identity.json");
}

/**
 * Load the persisted device identity, or create and persist a new one.
 * The file is written with mode 0600 to protect the private key.
 */
export async function loadOrCreateDeviceIdentity(
  filePath: string = defaultIdentityPath(),
): Promise<DeviceIdentity> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredDeviceIdentity>;
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.publicKeyPem === "string" &&
      typeof parsed.privateKeyPem === "string" &&
      typeof parsed.deviceId === "string" &&
      keyPairMatches(parsed.publicKeyPem, parsed.privateKeyPem)
    ) {
      const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
      return {
        deviceId: derivedId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
        publicKeyRawBase64Url: base64UrlEncode(
          derivePublicKeyRaw(parsed.publicKeyPem),
        ),
        createdAtMs:
          typeof parsed.createdAtMs === "number"
            ? parsed.createdAtMs
            : Date.now(),
      };
    }
  } catch {
    // file missing or invalid — fall through to create
  }
  const identity = generateIdentity();
  await persistIdentity(filePath, identity);
  return identity;
}

async function persistIdentity(
  filePath: string,
  identity: DeviceIdentity,
): Promise<void> {
  const dir = dirname(filePath);
  try {
    statSync(dir);
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stored: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: identity.createdAtMs,
  };
  await fs.writeFile(filePath, JSON.stringify(stored, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Lowercase + trim. Mirrors normalizeDeviceMetadataForAuth in OpenClaw so the
 * v3 payload string lines up exactly.
 */
function normalizeMetadataForAuth(value: string | undefined): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.toLowerCase();
}

export interface BuildConnectPayloadParams {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}

/**
 * Build the canonical v3 device-auth payload string. Must match
 * openclaw/dist/client-*.js#buildDeviceAuthPayloadV3 character-for-character
 * or signature verification on the gateway fails.
 */
export function buildDeviceAuthPayloadV3(
  params: BuildConnectPayloadParams,
): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = normalizeMetadataForAuth(params.platform);
  const deviceFamily = normalizeMetadataForAuth(params.deviceFamily);
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

/**
 * Sign a payload with the device's Ed25519 private key. Returns the signature
 * as base64url.
 */
export function signDevicePayload(
  privateKeyPem: string,
  payload: string,
): string {
  const key = createPrivateKey(privateKeyPem);
  return base64UrlEncode(cryptoSign(null, Buffer.from(payload, "utf8"), key));
}

export interface DeviceConnectBlock {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

/**
 * Build the `device:` block to attach to the connect frame's params.
 */
export function buildDeviceConnectBlock(params: {
  identity: DeviceIdentity;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}): DeviceConnectBlock {
  const payload = buildDeviceAuthPayloadV3({
    deviceId: params.identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs: params.signedAtMs,
    token: params.token,
    nonce: params.nonce,
    platform: params.platform,
    deviceFamily: params.deviceFamily,
  });
  return {
    id: params.identity.deviceId,
    publicKey: params.identity.publicKeyRawBase64Url,
    signature: signDevicePayload(params.identity.privateKeyPem, payload),
    signedAt: params.signedAtMs,
    nonce: params.nonce,
  };
}
