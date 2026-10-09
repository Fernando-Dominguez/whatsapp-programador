// Ingreso con huella / cara / PIN del dispositivo (llaves de acceso, WebAuthn).
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import db, { save, newId } from './db.js';
import { startUserSession, publicUser } from './auth.js';

const RP_NAME = 'Programador de WhatsApp';
const CHALLENGE_TTL = 5 * 60 * 1000;
/** desafíos pendientes: challenge -> { userId?, exp } */
const pending = new Map();

function rp(req) {
  const host = req.get('host') || 'localhost';
  return { rpID: host.split(':')[0], origin: `${req.protocol}://${host}` };
}
function remember(challenge, userId) {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  pending.set(challenge, { userId, exp: now + CHALLENGE_TTL });
}
/** Acepta un desafío pendiente (y lo consume), opcionalmente de un usuario dado. */
function takeChallenge(challenge, userId) {
  const p = pending.get(challenge);
  if (!p || p.exp < Date.now() || (userId && p.userId !== userId)) return false;
  pending.delete(challenge);
  return true;
}

const b64 = (u8) => Buffer.from(u8).toString('base64url');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

function deviceName(ua = '') {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Celular Android';
  if (/Windows/i.test(ua)) return 'Compu Windows';
  if (/Mac OS/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Compu Linux';
  return 'Dispositivo';
}

// ---------- Registrar (usuario ya logueado) ----------
export async function registerOptions(req, res) {
  const u = db.users.find((x) => x.id === req.user.id);
  if (!u) throw new Error('Primero creá un usuario e iniciá sesión con contraseña');
  const { rpID } = rp(req);
  if (!u.webauthnId) {
    u.webauthnId = b64(crypto.randomBytes(16));
    save();
  }
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: u.username,
    userDisplayName: u.name,
    userID: fromB64(u.webauthnId),
    attestationType: 'none',
    excludeCredentials: (u.passkeys || []).map((k) => ({ id: k.id, transports: k.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  remember(options.challenge, u.id);
  res.json(options);
}

export async function registerVerify(req, res) {
  const u = db.users.find((x) => x.id === req.user.id);
  if (!u) throw new Error('Usuario no encontrado');
  const { rpID, origin } = rp(req);
  const v = await verifyRegistrationResponse({
    response: req.body,
    expectedChallenge: (c) => takeChallenge(c, u.id),
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!v.verified) throw new Error('No se pudo verificar la huella');
  const c = v.registrationInfo.credential;
  u.passkeys = (u.passkeys || []).filter((k) => k.id !== c.id);
  u.passkeys.push({
    id: c.id,
    publicKey: b64(c.publicKey),
    counter: c.counter,
    transports: c.transports || req.body?.response?.transports || [],
    name: deviceName(req.get('user-agent')),
    createdAt: new Date().toISOString(),
  });
  save();
  res.json({ ok: true, passkeys: listOf(u) });
}

// ---------- Entrar con huella (sin usuario ni contraseña) ----------
export async function loginOptions(req, res) {
  const { rpID } = rp(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
  remember(options.challenge, null);
  res.json(options);
}

export async function loginVerify(req, res) {
  const credId = req.body?.id;
  const u = db.users.find((x) => (x.passkeys || []).some((k) => k.id === credId));
  if (!u) throw new Error('Esta huella no está registrada en la app. Entrá con tu contraseña y activala en "Mi cuenta".');
  const key = u.passkeys.find((k) => k.id === credId);
  const { rpID, origin } = rp(req);
  const v = await verifyAuthenticationResponse({
    response: req.body,
    expectedChallenge: (c) => takeChallenge(c, null),
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: { id: key.id, publicKey: fromB64(key.publicKey), counter: key.counter, transports: key.transports },
    requireUserVerification: true,
  });
  if (!v.verified) throw new Error('No se pudo verificar la huella');
  key.counter = v.authenticationInfo.newCounter;
  key.lastUsed = new Date().toISOString();
  save();
  startUserSession(req, res, u);
  res.json(publicUser(u));
}

// ---------- Ver / borrar ----------
const listOf = (u) => (u.passkeys || []).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsed: k.lastUsed }));
export function listPasskeys(req, res) {
  const u = db.users.find((x) => x.id === req.user.id);
  res.json(u ? listOf(u) : []);
}
export function deletePasskey(req, res) {
  const u = db.users.find((x) => x.id === req.user.id);
  if (u) {
    u.passkeys = (u.passkeys || []).filter((k) => k.id !== req.params.id);
    save();
  }
  res.json({ ok: true, passkeys: u ? listOf(u) : [] });
}
