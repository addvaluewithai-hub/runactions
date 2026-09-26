#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [filePath, publicId, leadName = ''] = process.argv.slice(2);
if (!filePath || !publicId) {
  throw new Error('Usage: upload_video_cloudinary.mjs <file> <public-id> [lead-name]');
}
if (!fs.existsSync(filePath)) {
  throw new Error(`Video file not found: ${filePath}`);
}

let cloudinaryUrl = (process.env.CLOUDINARY_URL || '').trim();
if (!cloudinaryUrl) {
  throw new Error('CLOUDINARY_URL is not set');
}

// Cloudinary's dashboard often presents the environment variable as the full
// shell assignment: CLOUDINARY_URL=cloudinary://.... GitHub Secrets should
// ideally contain only the URL, but accept both forms (and optional quotes).
cloudinaryUrl = cloudinaryUrl.replace(/^CLOUDINARY_URL\s*=\s*/i, '').trim();
if (
  cloudinaryUrl.length >= 2 &&
  ((cloudinaryUrl.startsWith('"') && cloudinaryUrl.endsWith('"')) ||
    (cloudinaryUrl.startsWith("'") && cloudinaryUrl.endsWith("'")))
) {
  cloudinaryUrl = cloudinaryUrl.slice(1, -1).trim();
}

if (!cloudinaryUrl.startsWith('cloudinary://')) {
  throw new Error(
    'CLOUDINARY_URL must be the Cloudinary API Environment variable beginning with cloudinary:// (not a dashboard URL or API key alone)'
  );
}

// Normalize the environment before loading the Cloudinary SDK because the SDK
// reads CLOUDINARY_URL during module initialization.
process.env.CLOUDINARY_URL = cloudinaryUrl;
const require = createRequire(import.meta.url);
const { v2: cloudinary } = require('cloudinary');

const parsed = new URL(cloudinaryUrl);
cloudinary.config({
  cloud_name: parsed.hostname,
  api_key: decodeURIComponent(parsed.username),
  api_secret: decodeURIComponent(parsed.password),
  secure: true,
});

const assetFolder = process.env.CLOUDINARY_ASSET_FOLDER || 'qserve-pilot-videos';
const result = await cloudinary.uploader.upload(filePath, {
  resource_type: 'video',
  type: 'upload',
  access_mode: 'public',
  asset_folder: assetFolder,
  public_id: publicId,
  display_name: leadName ? `${leadName} — QServe WhatsApp` : publicId,
  overwrite: true,
  invalidate: true,
  use_filename: false,
  unique_filename: false,
});

const payload = {
  leadName,
  publicId: result.public_id,
  assetId: result.asset_id,
  secureUrl: result.secure_url,
  bytes: result.bytes,
  duration: result.duration,
  format: result.format,
  width: result.width,
  height: result.height,
  resourceType: result.resource_type,
  createdAt: result.created_at,
};

const outDir = process.env.CLOUDINARY_OUTPUT_DIR || 'output';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'cloudinary.json'), JSON.stringify(payload, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'cloudinary-url.txt'), `${result.secure_url}\n`);

console.log(`Cloudinary upload complete: ${result.public_id}`);
console.log(`Cloudinary secure URL: ${result.secure_url}`);
