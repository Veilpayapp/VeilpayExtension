#!/usr/bin/env node
/**
 * Generates the deterministic Stellar deployer keypair for the Veilpay SPP
 * testnet pool deployment.
 *
 * The seed is fixed so the deployment is reproducible and the admin identity
 * is recoverable from this script alone. Prints the G... address and the
 * S... secret key (secret goes to stdout only — the deployment tooling needs
 * it; it is never committed).
 */

import { base32 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';

function crc16Xmodem(bytes) {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function strkey(versionByte, payload) {
  const framed = new Uint8Array(1 + payload.length + 2);
  framed[0] = versionByte;
  framed.set(payload, 1);
  const checksum = crc16Xmodem(framed.subarray(0, 1 + payload.length));
  framed[framed.length - 2] = checksum & 0xff;
  framed[framed.length - 1] = (checksum >> 8) & 0xff;
  return base32.encode(framed);
}

const seedHex = '5645696c70617920737070206465706c6f7965722073656564212121';
const seed = new Uint8Array(32);
for (let i = 0; i < 32; i += 1) {
  seed[i] = Number.parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
}

const publicKey = ed25519.getPublicKey(seed);
console.log(JSON.stringify({ address: strkey(6 << 3, publicKey), secret: strkey(18 << 3, seed) }, null, 2));
