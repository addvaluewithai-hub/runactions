#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';

const [filePath, publicId, leadName = ''] = process.argv.slice(2);
if (!filePath || !publicId) {
  throw new Error('Usage: upload_video_cloudinary.mjs <file> <public-id> [lead-name]');
}
if (!fs.existsSync(filePath)) {
  throw new Error(`Video file not found: ${filePath}`);
}

const cloudinaryUrl = (process.env.CLOUDINARY_URL || '').trim();
if (!cloudinaryUrl) {
  throw new Error('CLOUDINARY_URL is not set');
}

const parsed = new URL(cloudinaryUrl);
if (parsed.protocol !== 'cloudinary:') {
  throw new Error('CLOUDINARY_URL must use cloudinary:// scheme');
}

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
