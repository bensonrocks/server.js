'use strict';

const crypto = require('crypto');

/**
 * Security Service
 * Handles credential encryption, rate limiting, and data protection
 */
module.exports = function createSecurity(encryptionKey) {
  const ALGORITHM = 'aes-256-gcm';
  const key = crypto.scryptSync(encryptionKey || 'default-key', 'salt', 32);

  const encrypt = (plaintext) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  };

  const decrypt = (encrypted) => {
    const [ivHex, authTagHex, encryptedHex] = encrypted.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  };

  const rateLimiter = () => {
    const requests = new Map();

    const isAllowed = (key, limit = 100, window = 60000) => {
      const now = Date.now();
      const record = requests.get(key) || { count: 0, resetTime: now + window };

      if (now > record.resetTime) {
        record.count = 0;
        record.resetTime = now + window;
      }

      record.count++;

      if (record.count > limit) {
        return false;
      }

      requests.set(key, record);
      return true;
    };

    const getRemainingCalls = (key) => {
      const record = requests.get(key);
      if (!record) return 100;
      return Math.max(0, 100 - record.count);
    };

    return { isAllowed, getRemainingCalls };
  };

  const maskPII = (email) => {
    if (!email) return '';
    const [user, domain] = email.split('@');
    return `${user.substring(0, 2)}***@${domain}`;
  };

  const validateJWT = (token) => {
    // Simplified JWT validation
    if (!token || !token.startsWith('Bearer ')) return false;
    const payload = token.replace('Bearer ', '');
    return payload.length > 0;
  };

  return {
    encrypt,
    decrypt,
    rateLimiter,
    maskPII,
    validateJWT,
  };
};
