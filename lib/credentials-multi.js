'use strict';

const crypto = require('crypto');
const connectionsDb = require('./db/connections');

module.exports = function createMultiCredentials(tenantId) {
  const generateId = () => `cred_${crypto.randomBytes(8).toString('hex')}`;

  const saveCredentials = (platform, source, credData, setAsActive = true) => {
    const id = generateId();
    const now = new Date().toISOString();

    // If setting as active, deactivate other credentials for this platform
    if (setAsActive) {
      connectionsDb.prepare(`
        UPDATE platform_credentials_v2
        SET is_active = 0, updated_at = ?
        WHERE tenant_id = ? AND platform = ? AND is_deleted = 0
      `).run(now, tenantId, platform);
    }

    // Insert new credential
    connectionsDb.prepare(`
      INSERT INTO platform_credentials_v2
      (id, tenant_id, platform, source, data, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      tenantId,
      platform,
      source,
      JSON.stringify(credData),
      setAsActive ? 1 : 0,
      now,
      now
    );

    return {
      id,
      platform,
      source,
      isActive: setAsActive,
      createdAt: now,
      updatedAt: now
    };
  };

  const getActiveCredentials = (platform) => {
    const row = connectionsDb.prepare(`
      SELECT id, data, source, created_at, updated_at
      FROM platform_credentials_v2
      WHERE tenant_id = ? AND platform = ? AND is_active = 1 AND is_deleted = 0
      LIMIT 1
    `).get(tenantId, platform);

    if (!row) return null;
    try {
      return {
        id: row.id,
        platform,
        source: row.source,
        data: JSON.parse(row.data),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    } catch {
      return null;
    }
  };

  const getAllCredentials = (platform) => {
    const rows = connectionsDb.prepare(`
      SELECT id, platform, source, data, is_active, created_at, updated_at
      FROM platform_credentials_v2
      WHERE tenant_id = ? AND platform = ? AND is_deleted = 0
      ORDER BY is_active DESC, created_at DESC
    `).all(tenantId, platform);

    return rows.map(row => {
      try {
        return {
          id: row.id,
          platform: row.platform,
          source: row.source,
          data: JSON.parse(row.data),
          isActive: row.is_active === 1,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  };

  const activateCredentials = (credentialId) => {
    const row = connectionsDb.prepare(`
      SELECT platform FROM platform_credentials_v2
      WHERE id = ? AND tenant_id = ? AND is_deleted = 0
    `).get(credentialId, tenantId);

    if (!row) return null;

    const now = new Date().toISOString();

    // Deactivate all for this platform
    connectionsDb.prepare(`
      UPDATE platform_credentials_v2
      SET is_active = 0, updated_at = ?
      WHERE tenant_id = ? AND platform = ? AND is_deleted = 0
    `).run(now, tenantId, row.platform);

    // Activate the requested one
    connectionsDb.prepare(`
      UPDATE platform_credentials_v2
      SET is_active = 1, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(now, credentialId, tenantId);

    return getActiveCredentials(row.platform);
  };

  const deleteCredentials = (credentialId) => {
    const row = connectionsDb.prepare(`
      SELECT platform FROM platform_credentials_v2
      WHERE id = ? AND tenant_id = ? AND is_deleted = 0
    `).get(credentialId, tenantId);

    if (!row) return null;

    const now = new Date().toISOString();

    // Soft delete
    connectionsDb.prepare(`
      UPDATE platform_credentials_v2
      SET is_deleted = 1, is_active = 0, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(now, credentialId, tenantId);

    // If this was active, activate the most recent active-capable credential
    const nextCred = connectionsDb.prepare(`
      SELECT id FROM platform_credentials_v2
      WHERE tenant_id = ? AND platform = ? AND is_deleted = 0
      ORDER BY created_at DESC
      LIMIT 1
    `).get(tenantId, row.platform);

    if (nextCred) {
      connectionsDb.prepare(`
        UPDATE platform_credentials_v2
        SET is_active = 1, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(now, nextCred.id, tenantId);
    }

    return true;
  };

  return {
    saveCredentials,
    getActiveCredentials,
    getAllCredentials,
    activateCredentials,
    deleteCredentials
  };
};
