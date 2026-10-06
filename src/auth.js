// Usuarios, contraseñas y sesiones (sin dependencias externas).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import db, { save, newId, DATA_DIR } from './db.js';

if (!db.users) db.users = [];

// Clave para firmar las cookies de sesión. Se toma de SESSION_SECRET o se genera una vez y se guarda.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();
const COOKIE = 'wap_sesion';
const MAX_AGE_DAYS = 30;

// ---------- Contraseñas ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored || '').split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// ---------- Usuarios ----------
export const publicUser = (u) => u && { id: u.id, username: u.username, name: u.name, role: u.role };

export function createUser({ username, name, password, role = 'usuario' }) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('El usuario debe tener 3 a 30 letras, números, punto o guion');
  if (String(password || '').length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
  if (!['admin', 'usuario'].includes(role)) throw new Error('Rol inválido');
  if (db.users.some((u) => u.username === username)) throw new Error('Ese usuario ya existe');
  const u = { id: newId(), username, name: String(name || username).trim(), role, hash: hashPassword(password), createdAt: new Date().toISOString() };
  db.users.push(u);
  save();
  return u;
}

export function updateUser(id, { name, password, role }) {
  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error('Usuario no encontrado');
  if (name !== undefined) u.name = String(name).trim() || u.username;
  if (password) {
    if (String(password).length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
    u.hash = hashPassword(password);
    u.tokenVersion = (u.tokenVersion || 0) + 1; // cierra sus otras sesiones
  }
  if (role && role !== u.role) {
    if (!['admin', 'usuario'].includes(role)) throw new Error('Rol inválido');
    if (u.role === 'admin' && db.users.filter((x) => x.role === 'admin').length === 1) throw new Error('Tiene que quedar al menos un administrador');
    u.role = role;
  }
  save();
  return u;
}

export function deleteUser(id) {
  const u = db.users.find((x) => x.id === id);
  if (!u) return;
  if (u.role === 'admin' && db.users.filter((x) => x.role === 'admin').length === 1) throw new Error('No podés borrar al único administrador');
  db.users = db.users.filter((x) => x.id !== id);
  save();
}

// ---------- Sesiones (cookie firmada) ----------
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function makeToken(u) {
  const payload = Buffer.from(JSON.stringify({ id: u.id, v: u.tokenVersion || 0, exp: Date.now() + MAX_AGE_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readToken(tok) {
  const [payload, sig] = String(tok || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (p.exp < Date.now()) return null;
    const u = db.users.find((x) => x.id === p.id);
    if (!u || (u.tokenVersion || 0) !== p.v) return null;
    return u;
  } catch {
    return null;
  }
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(req, res, value, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}

// Freno simple a intentos de login: 10 fallos por IP cada 15 minutos.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(ip, a);
  return a.length >= 10;
}

export function login(req, res) {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' });
  const { username, password } = req.body || {};
  const u = db.users.find((x) => x.username === String(username || '').trim().toLowerCase());
  if (!u || !checkPassword(password, u.hash)) {
    attempts.get(ip).push(Date.now());
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  attempts.delete(ip);
  setCookie(req, res, makeToken(u), MAX_AGE_DAYS * 86400);
  res.json(publicUser(u));
}

export function logout(req, res) {
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}

/**
 * Exige sesión iniciada. Excepción: si todavía no hay ningún usuario creado y el
 * pedido viene de la misma compu (uso local en Windows), deja entrar como admin.
 */
export function requireAuth(req, res, next) {
  const u = readToken(getCookie(req, COOKIE));
  if (u) {
    req.user = u;
    return next();
  }
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
  if (db.users.length === 0 && local) {
    req.user = { id: 'local', username: 'local', name: 'Local', role: 'admin', local: true };
    return next();
  }
  res.status(401).json({ error: 'Iniciá sesión', needLogin: true });
}

export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Solo un administrador puede hacer esto' });
}
