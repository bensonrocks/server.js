const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');
const path = require('path');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. See .env.example for setup.`);
  }
  return value;
}

let client;
function getClient() {
  if (!client) {
    client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
        secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
      },
    });
  }
  return client;
}

/**
 * Uploads a buffer to object storage and returns its public URL.
 * @param {Buffer} buffer
 * @param {string} originalName
 * @param {string} mimeType
 * @param {string} folder
 */
async function uploadFile(buffer, originalName, mimeType, folder) {
  const bucket = requireEnv('S3_BUCKET');
  const ext = path.extname(originalName || '') || '';
  const key = `${folder}/${randomUUID()}${ext}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ACL: 'public-read',
    })
  );

  const base = process.env.S3_PUBLIC_URL_BASE || `https://${bucket}.s3.amazonaws.com`;
  return `${base.replace(/\/$/, '')}/${key}`;
}

module.exports = { uploadFile };
