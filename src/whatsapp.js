// Conexiones a WhatsApp (como WhatsApp Web) vía Baileys: una sesión por usuario.
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { DATA_DIR } from './db.js';
import { upsertContacts, addLidMappings, searchContacts, contactCount, deleteContacts } from './contacts.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sesiones');
const LEGACY_DIR = path.join(DATA_DIR, 'sesion-whatsapp'); // versión anterior (un solo WhatsApp)
// Si alguien pidió el QR y no lo escanea, se deja de generar después de este tiempo.
const QR_IDLE_MS = 3 * 60 * 1000;

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/** userId -> { status, qr, me, sock, starting, retry, lastSeen } */
const sessions = new Map();

const authDir = (userId) => path.join(SESSIONS_DIR, String(userId).replace(/[^\w-]/g, '_'));
const hasCreds = (userId) => fs.existsSync(path.join(authDir(userId), 'creds.json'));
/** true si ese usuario ya terminó de vincular su WhatsApp (no solo empezó). */
function isRegistered(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')).registered === true;
  } catch {
    return false;
  }
}

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { status: 'desconectado', qr: null, me: null, sock: null });
  return sessions.get(userId);
}

let baileysVersion;
async function version() {
  if (baileysVersion) return baileysVersion;
  try {
    ({ version: baileysVersion } = await fetchLatestBaileysVersion());
  } catch {
    /* usa la versión por defecto */
  }
  return baileysVersion;
}

/**
 * Pasa una sesión ya vinculada al usuario indicado: la de la versión anterior
 * (un solo WhatsApp) o la del uso local sin usuarios.
 */
export function migrateLegacySession(userId) {
  if (hasCreds(userId)) return false;
  for (const from of [LEGACY_DIR, userId === 'local' ? null : authDir('local')]) {
    if (!from || !fs.existsSync(path.join(from, 'creds.json'))) continue;
    const wasRunning = from === authDir('local') && sessions.get('local')?.sock;
    if (from === authDir('local')) { stopSocket('local'); sessions.delete('local'); }
    fs.rmSync(authDir(userId), { recursive: true, force: true });
    fs.renameSync(from, authDir(userId));
    console.log(`Sesión de WhatsApp existente asignada al usuario ${userId}`);
    if (wasRunning) startSession(userId);
    return true;
  }
  return false;
}

export async function startSession(userId) {
  const s = getSession(userId);
  if (s.starting || s.sock) return;
  s.starting = true;
  clearTimeout(s.retry);
  try {
    s.status = 'conectando';
    const { state, saveCreds } = await useMultiFileAuthState(authDir(userId));
    const sock = makeWASocket({
      auth: state,
      version: await version(),
      logger: pino({ level: 'silent' }),
      browser: ['Programador WhatsApp', 'Chrome', '1.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    s.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    // Contactos: los manda WhatsApp al vincular (y luego actualizaciones)
    sock.ev.on('messaging-history.set', ({ contacts, lidPnMappings }) => {
      addLidMappings(userId, lidPnMappings);
      upsertContacts(userId, contacts);
    });
    sock.ev.on('contacts.upsert', (list) => upsertContacts(userId, list));
    sock.ev.on('contacts.update', (list) => upsertContacts(userId, list));
    // Gente que te escribe: guardar el nombre que tiene puesto en WhatsApp
    sock.ev.on('messages.upsert', ({ messages }) => {
      const list = [];
      for (const m of messages || []) {
        const jid = m.key?.remoteJid;
        if (m.key?.fromMe || !m.pushName || !jid || jid.endsWith('@g.us')) continue;
        list.push({ id: jid, phoneNumber: m.key?.remoteJidAlt || m.key?.senderPn, notify: m.pushName });
      }
      if (list.length) upsertContacts(userId, list);
    });
    sock.ev.on('connection.update', async (u) => {
      if (s.sock !== sock) return; // evento de una conexión vieja
      if (u.qr) {
        // Nadie está mirando el QR: no seguir generándolo
        if (!isRegistered(authDir(userId)) && Date.now() - (s.lastSeen || 0) > QR_IDLE_MS) {
          stopSocket(userId);
          s.status = 'desconectado';
          return;
        }
        s.status = 'esperando-qr';
        s.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 300 });
      }
      if (u.connection === 'open') {
        s.status = 'conectado';
        s.qr = null;
        s.me = { id: sock.user?.id, name: sock.user?.name || sock.user?.verifiedName || '' };
        console.log(`✔ WhatsApp conectado (usuario ${userId}: ${s.me.id})`);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        s.sock = null;
        s.me = null;
        s.qr = null;
        if (code === DisconnectReason.loggedOut) {
          console.log(`Usuario ${userId}: sesión cerrada desde el teléfono.`);
          fs.rmSync(authDir(userId), { recursive: true, force: true });
          s.status = 'desconectado';
        } else if (s.stopped) {
          s.status = 'desconectado';
        } else {
          s.status = 'conectando';
          s.retry = setTimeout(() => startSession(userId), code === DisconnectReason.restartRequired ? 500 : 5000);
        }
      }
    });
    s.stopped = false;
  } catch (e) {
    console.error(`Error iniciando WhatsApp (usuario ${userId}):`, e.message);
    s.status = 'desconectado';
    s.retry = setTimeout(() => startSession(userId), 10000);
  } finally {
    s.starting = false;
  }
}

function stopSocket(userId) {
  const s = getSession(userId);
  clearTimeout(s.retry);
  s.stopped = true;
  try {
    s.sock?.end(undefined);
  } catch {
    /* ignorar */
  }
  s.sock = null;
  s.qr = null;
  s.me = null;
}

/** Estado para el panel. Pedirlo "despierta" la sesión para que aparezca el QR. */
export function sessionStatus(userId) {
  const s = getSession(userId);
  s.lastSeen = Date.now();
  if (!s.sock && !s.starting && s.status !== 'conectando' && process.env.SIN_WHATSAPP !== '1') startSession(userId);
  return { status: s.status, qr: s.qr, me: s.me };
}

/**
 * Vinculación con código (sin QR), para cuando se usa el panel desde el mismo celular.
 * Devuelve un código de 8 caracteres para ingresar en WhatsApp → Dispositivos vinculados
 * → Vincular un dispositivo → "Vincular con el número de teléfono".
 */
export async function requestPairCode(userId, phone) {
  const num = normalizePhone(phone);
  if (num.length < 10) throw new Error('Escribí tu número completo, con código de área');
  const s = getSession(userId);
  if (s.status === 'conectado') throw new Error('Tu WhatsApp ya está conectado');
  s.lastSeen = Date.now();
  if (!s.sock && !s.starting) startSession(userId);
  // Esperar a que la conexión esté lista para vincular (cuando WhatsApp manda el primer QR)
  for (let i = 0; i < 40 && s.status !== 'esperando-qr'; i++) await new Promise((r) => setTimeout(r, 500));
  if (!s.sock || s.status !== 'esperando-qr') throw new Error('No se pudo preparar la vinculación. Probá de nuevo en unos segundos.');
  const code = await s.sock.requestPairingCode(num);
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export const isConnected = (userId) => getSession(userId).status === 'conectado';

export async function logoutSession(userId) {
  const s = getSession(userId);
  try {
    await s.sock?.logout();
  } catch {
    /* ignorar */
  }
  stopSocket(userId);
  fs.rmSync(authDir(userId), { recursive: true, force: true });
  s.status = 'desconectado';
}

/** Al borrar un usuario: corta y elimina su sesión. */
export async function removeSession(userId) {
  await logoutSession(userId);
  deleteContacts(userId);
  sessions.delete(userId);
}

/** Al arrancar: reconecta a todos los usuarios que ya tenían su WhatsApp vinculado. */
export function startSavedSessions() {
  for (const dir of fs.readdirSync(SESSIONS_DIR)) {
    if (isRegistered(path.join(SESSIONS_DIR, dir))) startSession(dir);
  }
}

/**
 * Normaliza un número a formato internacional sin "+".
 * Pensado para Argentina: agrega 54 9 a números locales de 10 dígitos
 * y el 9 de celular si falta. Quita el 15 cuando viene en formato 54 9 11 15...
 */
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1); // 011... -> 11...
  if (d.length === 12 && !d.startsWith('54')) {
    // 11 15 2345 6789: quitar el 15 que va después del código de área
    for (const areaLen of [2, 3, 4]) {
      if (d.substr(areaLen, 2) === '15') {
        d = d.slice(0, areaLen) + d.slice(areaLen + 2);
        break;
      }
    }
  }
  if (d.length === 10) d = '549' + d; // 11 2345 6789
  if (d.startsWith('54') && !d.startsWith('549') && d.length === 12) d = '549' + d.slice(2);
  // 54 9 <área> 15 <número>: quitar el 15 (área de 2 a 4 dígitos)
  if (d.startsWith('549') && d.length === 15) {
    for (const areaLen of [2, 3, 4]) {
      if (d.substr(3 + areaLen, 2) === '15') {
        d = d.slice(0, 3 + areaLen) + d.slice(5 + areaLen);
        break;
      }
    }
  }
  return d;
}

/** Busca en los contactos de WhatsApp del usuario. */
export function findContacts(userId, q) {
  const sock = getSession(userId).sock;
  const resolveLid = sock?.signalRepository?.lidMapping
    ? async (lid) => {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
        return pn ? String(pn).split('@')[0].split(':')[0] : null;
      }
    : null;
  return searchContacts(userId, q, resolveLid);
}
export { contactCount };

const jidCache = new Map();

function connectedSock(userId) {
  const s = getSession(userId);
  if (!s.sock || s.status !== 'conectado') throw new Error('WhatsApp no está conectado');
  return s.sock;
}

/** Devuelve el JID real de WhatsApp para un número, o lanza error si no tiene WhatsApp. */
export async function resolvePhoneJid(userId, phone) {
  const num = normalizePhone(phone);
  if (num.length < 8) throw new Error(`Número inválido: ${phone}`);
  if (jidCache.has(num)) return jidCache.get(num);
  const res = await connectedSock(userId).onWhatsApp(num);
  const hit = res?.find((r) => r.exists);
  if (!hit) throw new Error(`El número ${num} no tiene WhatsApp`);
  jidCache.set(num, hit.jid);
  return hit.jid;
}

export async function listGroups(userId) {
  const groups = await connectedSock(userId).groupFetchAllParticipating();
  return Object.values(groups)
    .map((g) => ({ id: g.id, name: g.subject, size: g.participants?.length || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/** Envía texto (y opcionalmente un archivo adjunto) a un JID desde el WhatsApp del usuario. */
export async function sendTo(userId, jid, text, attachment) {
  const sock = connectedSock(userId);
  if (!attachment) return sock.sendMessage(jid, { text });
  const buffer = fs.readFileSync(attachment.path);
  const mt = attachment.mimetype || 'application/octet-stream';
  if (mt.startsWith('image/')) return sock.sendMessage(jid, { image: buffer, caption: text || undefined });
  if (mt.startsWith('video/')) return sock.sendMessage(jid, { video: buffer, caption: text || undefined });
  if (mt.startsWith('audio/')) {
    await sock.sendMessage(jid, { audio: buffer, mimetype: mt });
    if (text) await sock.sendMessage(jid, { text });
    return;
  }
  return sock.sendMessage(jid, {
    document: buffer,
    mimetype: mt,
    fileName: attachment.name,
    caption: text || undefined,
  });
}
export const _sessionsForTests = sessions;
