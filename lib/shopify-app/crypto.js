'use strict';
const crypto = require('crypto');

const ALG = 'aes-256-gcm';

function getKey() {
  const raw = process.env.SHOPIFY_TOKEN_SECRET || '';
  if (!raw) throw new Error('SHOPIFY_TOKEN_SECRET env var not set (need 32-byte secret)');
  const buf = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64');
  if (buf.length !== 32) throw new Error('SHOPIFY_TOKEN_SECRET must be 32 bytes (64-char hex or 44-char base64)');
  return buf;
}

function encrypt(plaintext) {
  const key  = getKey();
  const iv   = crypto.randomBytes(12);
  const ciph = crypto.createCipheriv(ALG, key, iv);
  const enc  = Buffer.concat([ciph.update(plaintext, 'utf8'), ciph.final()]);
  const tag  = ciph.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`;
}

function decrypt(ciphertext) {
  const key  = getKey();
  const [ivHex, tagHex, dataHex] = ciphertext.split('.');
  const deciph = crypto.createDecipheriv(ALG, key, Buffer.from(ivHex, 'hex'));
  deciph.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([deciph.update(Buffer.from(dataHex, 'hex')), deciph.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
