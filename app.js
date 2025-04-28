// app.js - Simple image upload & delete API backed by AWS S3
// Matches the parameter/response style of the imgbb example
// -----------------------------------------------------------
// Author: Sysport Team
// Usage:
//   1. npm install express multer @aws-sdk/client-s3 uuid sharp dotenv
//   2. Create a .env file with the variables shown at the end of this file
//   3. node app.js (or use nodemon for auto‑reload)
//
// Endpoints:
//   POST   /upload               -> upload image (multipart/form‑data)
//   DELETE /image/:filename      -> delete previously‑uploaded image
// -----------------------------------------------------------

const express = require('express');
const multer  = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const path  = require('path');
const dotenv = require('dotenv');

dotenv.config();

// ─────────────────────────────────────────────────────────────
// Basic config
// ─────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const BUCKET      = process.env.S3_BUCKET;
const REGION      = process.env.AWS_REGION;
const VALID_KEYS  = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

if (!BUCKET || !REGION) {
  console.error('❌  Missing S3_BUCKET or AWS_REGION env vars');
  process.exit(1);
}

// S3 client (SDK v3)
const s3 = new S3Client({ region: REGION });

// Multer in‑memory storage (32 MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 }
});

// ─────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const key = req.query.key || req.body.key;
  if (!key || !VALID_KEYS.includes(key)) {
    return res.status(401).json({ status: 401, error: 'Invalid API key' });
  }
  next();
}

function buildS3Url(filename) {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${filename}`;
}

function clampExpiration(sec) {
  const n = parseInt(sec, 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(60, Math.min(n, 15552000));
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
const app = express();

// POST /upload — image upload
app.post('/upload', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 400, error: 'Missing "image" field' });
    }

    // Generate identifiers & filenames
    const id        = uuidv4().slice(0, 7);               // 7‑char id like imgbb
    const ext       = path.extname(req.file.originalname) || `.${req.file.mimetype.split('/')[1]}`;
    const filename  = `${id}${ext}`;
    const title     = (req.body.name || path.parse(filename).name).replace(/\s+/g, '_');

    // Optional auto‑delete expiration (seconds)
    const expirationInput = req.query.expiration || req.body.expiration;
    const expiration      = expirationInput ? clampExpiration(expirationInput) : 0;

    // Extract basic image metadata (width/height)
    let width = '', height = '';
    try {
      const meta = await sharp(req.file.buffer).metadata();
      width  = meta.width?.toString()  || '';
      height = meta.height?.toString() || '';
    } catch (err) {
      /* non‑fatal */
    }

    // Upload to S3
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: filename,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      Metadata: {
        expiration: expiration.toString(),
        uploaded:   Math.floor(Date.now() / 1000).toString()
      }
    }));

    const url = buildS3Url(filename);
    const epoch = Math.floor(Date.now() / 1000).toString();

    // Build response in imgbb style
    res.json({
      data: {
        id,
        title,
        url_viewer: url,
        url,
        display_url: url,
        width,
        height,
        size: req.file.size.toString(),
        time: epoch,
        expiration: expiration.toString(),
        image: {
          filename,
          name: title,
          mime: req.file.mimetype,
          extension: ext.replace('.', ''),
          url
        },
        thumb: {
          filename,
          name: title,
          mime: req.file.mimetype,
          extension: ext.replace('.', ''),
          url
        }
      },
      status: 200,
      success: true
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 500, error: 'Upload failed' });
  }
});

// DELETE /image/:filename — delete object from S3
app.delete('/image/:filename', auth, async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename) {
      return res.status(400).json({ status: 400, error: 'Missing filename' });
    }

    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: filename }));
    res.json({ status: 200, success: true, message: 'Image deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 500, error: 'Delete failed' });
  }
});

// Start server
app.listen(PORT, () => console.log(`🚀  S3 Image API running on http://localhost:${PORT}`));

// ─────────────────────────────────────────────────────────────
// .env template
// ─────────────────────────────────────────────────────────────
// PORT=3000
// AWS_REGION=ap‑southeast‑1
// S3_BUCKET=my‑image‑bucket
// AWS_ACCESS_KEY_ID=YOUR_ACCESS_KEY
// AWS_SECRET_ACCESS_KEY=YOUR_SECRET_KEY
// API_KEYS=my‑secure‑api‑key (comma‑separated list if you need multiple)
// -----------------------------------------------------------
