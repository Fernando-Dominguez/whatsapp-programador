// Conexión a WhatsApp con tu propio número (como WhatsApp Web), vía Baileys.
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

const AUTH_DIR = path.join(DATA_DIR, 'sesion-whatsapp');

export const wa = {
  status: 'desconectado', // desconectado | conectando | esperando-qr | conectado
  qr: null, // data URL del QR
  me: null, // { id, name }
  sock: null,
};

let starting = false;
let retryTimer = null;

export async function startWhatsApp() {
  if (starting) return;
  starting = true;
  clearTimeout(retryTimer);
  try {
    wa.status = 'conectando';
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      /* usa la versión por defecto */
    }

    const sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'silent' }),
      browser: ['Programador WhatsApp', 'Chrome', '1.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    wa.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        wa.status = 'esperando-qr';
        wa.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 300 });
      }
      if (u.connection === 'open') {
        wa.status = 'conectado';
        wa.qr = null;
        wa.me = { id: sock.user?.id, name: sock.user?.name || sock.user?.verifiedName || '' };
        console.log(`✔ WhatsApp conectado (${wa.me.id})`);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        wa.sock = null;
        wa.me = null;
        if (code === DisconnectReason.loggedOut) {
          console.log('Sesión cerrada desde el teléfono. Hay que escanear el QR de nuevo.');
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          wa.status = 'desconectado';
          retryTimer = setTimeout(startWhatsApp, 1000);
        } else {
          wa.status = 'conectando';
          retryTimer = setTimeout(startWhatsApp, code === DisconnectReason.restartRequired ? 500 : 5000);
        }
      }
    });
  } catch (e) {
    console.error('Error iniciando WhatsApp:', e.message);
    wa.status = 'desconectado';
    retryTimer = setTimeout(startWhatsApp, 10000);
  } finally {
    starting = false;
  }
}

export async function logoutWhatsApp() {
  try {
    await wa.sock?.logout();
  } catch {
    /* ignorar */
  }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  wa.sock = null;
  wa.me = null;
  wa.status = 'desconectado';
  setTimeout(startWhatsApp, 1000);
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

const jidCache = new Map();

/** Devuelve el JID real de WhatsApp para un número, o lanza error si no tiene WhatsApp. */
export async function resolvePhoneJid(phone) {
  const num = normalizePhone(phone);
  if (num.length < 8) throw new Error(`Número inválido: ${phone}`);
  if (jidCache.has(num)) return jidCache.get(num);
  const res = await wa.sock.onWhatsApp(num);
  const hit = res?.find((r) => r.exists);
  if (!hit) throw new Error(`El número ${num} no tiene WhatsApp`);
  jidCache.set(num, hit.jid);
  return hit.jid;
}

export async function listGroups() {
  if (!wa.sock || wa.status !== 'conectado') throw new Error('WhatsApp no está conectado');
  const groups = await wa.sock.groupFetchAllParticipating();
  return Object.values(groups)
    .map((g) => ({ id: g.id, name: g.subject, size: g.participants?.length || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/** Envía texto (y opcionalmente un archivo adjunto) a un JID. */
export async function sendTo(jid, text, attachment) {
  if (!wa.sock || wa.status !== 'conectado') throw new Error('WhatsApp no está conectado');
  if (!attachment) return wa.sock.sendMessage(jid, { text });
  const buffer = fs.readFileSync(attachment.path);
  const mt = attachment.mimetype || 'application/octet-stream';
  if (mt.startsWith('image/')) return wa.sock.sendMessage(jid, { image: buffer, caption: text || undefined });
  if (mt.startsWith('video/')) return wa.sock.sendMessage(jid, { video: buffer, caption: text || undefined });
  if (mt.startsWith('audio/')) {
    await wa.sock.sendMessage(jid, { audio: buffer, mimetype: mt });
    if (text) await wa.sock.sendMessage(jid, { text });
    return;
  }
  return wa.sock.sendMessage(jid, {
    document: buffer,
    mimetype: mt,
    fileName: attachment.name,
    caption: text || undefined,
  });
}
