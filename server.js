'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const META_FILE = path.join(DATA_DIR, 'photos.json');

const MAX_PHOTO_SIZE = 30 * 1024 * 1024;
const PAGE_SIZE = 48;

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

const EXT_TO_MIME = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime])
);

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

fs.mkdirSync(PHOTOS_DIR, { recursive: true });

let photos = [];
try {
  const raw = fs.readFileSync(META_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) photos = parsed;
} catch (err) {
  if (err.code !== 'ENOENT') console.error('Не удалось прочитать photos.json:', err.message);
}

function saveMeta() {
  const tmp = `${META_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(photos), 'utf8');
  fs.renameSync(tmp, META_FILE);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(res.headOnly ? undefined : body);
}

function sendFile(res, file, type, cacheControl) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (res.headOnly) {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        const error = new Error('Файл слишком большой');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function publicPhoto(item, index) {
  return {
    id: item.id,
    url: `/photos/${item.id}.${item.ext}`,
    w: item.w,
    h: item.h,
    size: item.size,
    n: index + 1,
  };
}

async function handleUpload(req, res) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = MIME_TO_EXT[contentType];
  if (!ext) {
    json(res, 415, { error: 'Поддерживаются JPG, PNG, WebP, GIF и AVIF' });
    return;
  }

  const body = await readBody(req, MAX_PHOTO_SIZE);
  if (!body.length) {
    json(res, 400, { error: 'Пустой файл' });
    return;
  }

  const width = Math.min(20000, Math.max(1, parseInt(req.headers['x-width'], 10) || 1200));
  const height = Math.min(20000, Math.max(1, parseInt(req.headers['x-height'], 10) || 800));

  const id = crypto.randomUUID();
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, file), body);

  const item = { id, ext, w: width, h: height, size: body.length, at: Date.now() };
  photos.unshift(item);
  saveMeta();

  json(res, 201, { ok: true, photo: publicPhoto(item, photos.length - 1) });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    json(res, 400, { error: 'Некорректный адрес' });
    return;
  }

  const pathname = url.pathname;

  res.headOnly = req.method === 'HEAD';
  const method = res.headOnly ? 'GET' : req.method;

  try {
    if (pathname === '/api/photos' && method === 'GET') {
      const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
      const limit = Math.min(120, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || PAGE_SIZE));
      const slice = photos.slice(offset, offset + limit);
      json(res, 200, {
        total: photos.length,
        photos: slice.map((item, i) => publicPhoto(item, offset + i)),
      });
      return;
    }

    if (pathname === '/api/photos' && method === 'POST') {
      await handleUpload(req, res);
      return;
    }

    if (pathname.startsWith('/photos/') && method === 'GET') {
      const name = decodeURIComponent(pathname.slice('/photos/'.length));
      if (!/^[a-f0-9-]{36}\.(jpg|png|webp|gif|avif)$/.test(name)) {
        json(res, 400, { error: 'Некорректное имя файла' });
        return;
      }
      const ext = name.split('.').pop();
      sendFile(res, path.join(PHOTOS_DIR, name), EXT_TO_MIME[ext], 'public, max-age=31536000, immutable');
      return;
    }

    if (method === 'GET' && Object.hasOwn(STATIC_FILES, pathname)) {
      const [file, type] = STATIC_FILES[pathname];
      sendFile(res, path.join(PUBLIC_DIR, file), type, 'no-cache');
      return;
    }

    if (method === 'GET') {
      json(res, 404, { error: 'Страница не найдена' });
      return;
    }

    json(res, 405, { error: 'Метод не поддерживается' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Ошибка сервера' });
  }
});

server.listen(PORT, () => {
  console.log(`ТЕНЬ. — галерея доступна на http://localhost:${PORT}`);
  console.log(`Фото: ${photos.length}, папка: ${PHOTOS_DIR}`);
});
