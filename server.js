// Programador de mensajes de WhatsApp — servidor principal.
import './src/tz.js'; // primero: fija la zona horaria antes de todo lo demás
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { save, newId, MEDIA_DIR } from './src/db.js';
import { registerOptions, registerVerify, loginOptions, loginVerify, listPasskeys, deletePasskey } from './src/passkeys.js';
import { resyncContacts, findContacts, contactCount, requestPairCode, sessionStatus, isConnected, logoutSession, removeSession, startSavedSessions, migrateLegacySession, listGroups, normalizePhone } from './src/whatsapp.js';
import { login, logout, requireAuth, requireAdmin, createUser, updateUser, deleteUser, publicUser } from './src/auth.js';
import { startScheduler, runSchedule, computeNext, firstNext, expandTargets, REPEAT_LABELS } from './src/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const app = express();
app.set('trust proxy', 'loopback'); // detrás de Caddy (https) en el servidor
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Librería del navegador para la huella (servida desde el propio servidor)
app.get('/vendor/webauthn.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));

// ---------- Pasaje desde versiones anteriores ----------
// Todo lo que no tiene dueño (versión de un solo WhatsApp, o uso local sin usuarios)
// pasa al primer administrador, incluida la sesión de WhatsApp ya vinculada.
function adoptOrphans() {
  const admin = db.users.find((u) => u.role === 'admin');
  const owner = admin ? admin.id : 'local';
  let changed = false;
  for (const coll of [db.lists, db.schedules, db.history]) {
    for (const item of coll) {
      if (!item.ownerId || (admin && item.ownerId === 'local')) {
        item.ownerId = owner;
        changed = true;
      }
    }
  }
  if (changed) save();
  migrateLegacySession(owner);
}
adoptOrphans();

const mine = (req) => (item) => item.ownerId === req.user.id;
function findMine(req, coll, id, what) {
  const item = coll.find((x) => x.id === id && x.ownerId === req.user.id);
  if (!item) throw new Error(`${what} no encontrado`);
  return item;
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

// ---------- Sesión ----------
app.post('/api/login', login);
app.post('/api/salir', logout);
app.post('/api/passkey/login-options', wrap(loginOptions));
app.post('/api/passkey/login-verify', wrap(loginVerify));
app.use('/api', requireAuth);
app.get('/api/me', (req, res) => res.json({ ...publicUser(req.user), local: !!req.user.local }));

// ---------- Usuarios (solo admin) ----------
app.get('/api/users', requireAdmin, (req, res) =>
  res.json(db.users.map((u) => ({ ...publicUser(u), whatsapp: isConnected(u.id) }))));
app.post('/api/users', requireAdmin, wrap((req, res) => {
  const u = createUser(req.body);
  if (req.user.local) adoptOrphans(); // primer usuario creado desde la compu: se queda con lo que había
  res.json(publicUser(u));
}));
app.put('/api/users/:id', requireAdmin, wrap((req, res) => res.json(publicUser(updateUser(req.params.id, req.body)))));
app.delete('/api/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = req.params.id;
  if (id === req.user.id) throw new Error('No podés borrar tu propio usuario');
  deleteUser(id);
  // Se desvincula su WhatsApp y se borran sus envíos y listas (el historial queda)
  await removeSession(id);
  for (const sc of db.schedules.filter((x) => x.ownerId === id)) if (sc.attachment?.path) fs.rmSync(sc.attachment.path, { force: true });
  db.schedules = db.schedules.filter((x) => x.ownerId !== id);
  db.lists = db.lists.filter((x) => x.ownerId !== id);
  save();
  res.json({ ok: true });
}));
// Huellas / llaves de acceso del usuario
app.get('/api/passkeys', listPasskeys);
app.post('/api/passkeys/register-options', wrap(registerOptions));
app.post('/api/passkeys/register-verify', wrap(registerVerify));
app.delete('/api/passkeys/:id', deletePasskey);
// Cualquier usuario puede cambiar su propia contraseña
app.post('/api/me/password', wrap((req, res) => {
  if (req.user.local) throw new Error('Primero creá un usuario administrador');
  updateUser(req.user.id, { password: req.body.password });
  res.json({ ok: true });
}));

// ---------- Conexión ----------
app.get('/api/status', (req, res) => res.json({ ...sessionStatus(req.user.id), contacts: contactCount(req.user.id) }));
app.post('/api/contacts/resync', wrap(async (req, res) => res.json({ count: await resyncContacts(req.user.id) })));
app.get('/api/contacts', wrap(async (req, res) => res.json(await findContacts(req.user.id, String(req.query.q || '')))));
app.post('/api/pair', wrap(async (req, res) => res.json(await requestPairCode(req.user.id, req.body.phone))));
app.post('/api/logout', wrap(async (req, res) => { await logoutSession(req.user.id); res.json({ ok: true }); }));
app.get('/api/groups', wrap(async (req, res) => res.json(await listGroups(req.user.id))));

// ---------- Listas de contactos ----------
function parseContacts(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
    let phoneIdx = -1;
    let best = 0;
    parts.forEach((p, i) => {
      const digits = p.replace(/\D/g, '').length;
      if (digits >= 8 && digits > best && digits / p.replace(/\s/g, '').length > 0.6) { best = digits; phoneIdx = i; }
    });
    if (phoneIdx < 0) continue; // línea sin teléfono (ej. encabezado)
    const phone = normalizePhone(parts[phoneIdx]);
    const name = parts.filter((_, i) => i !== phoneIdx).join(' ').trim();
    out.push({ name, phone });
  }
  return out;
}
const contactsToText = (cs) => cs.map((c) => (c.name ? `${c.name}, ${c.phone}` : c.phone)).join('\n');

app.get('/api/lists', (req, res) =>
  res.json(db.lists.filter(mine(req)).map((l) => ({ ...l, text: contactsToText(l.contacts) }))));
app.post('/api/lists', wrap((req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new Error('La lista necesita un nombre');
  const list = { id: newId(), ownerId: req.user.id, name, contacts: parseContacts(req.body.text) };
  db.lists.push(list);
  save();
  res.json(list);
}));
app.put('/api/lists/:id', wrap((req, res) => {
  const list = findMine(req, db.lists, req.params.id, 'Lista');
  if (req.body.name) list.name = String(req.body.name).trim();
  if (req.body.text !== undefined) list.contacts = parseContacts(req.body.text);
  save();
  res.json(list);
}));
app.delete('/api/lists/:id', (req, res) => {
  db.lists = db.lists.filter((l) => !(l.id === req.params.id && l.ownerId === req.user.id));
  save();
  res.json({ ok: true });
});

// ---------- Envíos programados ----------
function saveAttachment(att) {
  if (!att?.data) return undefined;
  const safe = String(att.name || 'archivo').replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ]/g, '_');
  const file = path.join(MEDIA_DIR, `${newId()}-${safe}`);
  fs.writeFileSync(file, Buffer.from(att.data, 'base64'));
  return { path: file, name: att.name, mimetype: att.mimetype };
}

function validate(body) {
  const text = String(body.text || '');
  if (!text.trim() && !body.attachment && !body.keepAttachment) throw new Error('Escribí un mensaje o adjuntá un archivo');
  if (!Array.isArray(body.targets) || !body.targets.length) throw new Error('Elegí al menos un destinatario');
  const first = new Date(body.firstRun);
  if (isNaN(first)) throw new Error('Fecha u hora inválida');
  if (!REPEAT_LABELS[body.repeat || 'none']) throw new Error('Repetición inválida');
  const targets = body.targets.map((t) => (t.type === 'phone' ? { ...t, phone: normalizePhone(t.phone) } : t));
  return { text, targets, firstRun: first.toISOString(), repeat: body.repeat || 'none', title: String(body.title || '').trim() };
}

function schedulePlan(s) {
  const now = new Date();
  const start = firstNext(s);
  const next = start > now ? start : computeNext(s, now);
  return next ? next.toISOString() : null;
}

const view = (s) => ({
  ...s,
  attachment: s.attachment ? { name: s.attachment.name, mimetype: s.attachment.mimetype } : null,
  recipientsCount: expandTargets(s.targets, s.ownerId).length,
  repeatLabel: REPEAT_LABELS[s.repeat],
});

app.get('/api/schedules', (req, res) => {
  const list = db.schedules.filter(mine(req)).sort((a, b) => {
    if (!!a.nextRun !== !!b.nextRun) return a.nextRun ? -1 : 1;
    return new Date(a.nextRun || b.lastRun || 0) - new Date(b.nextRun || a.lastRun || 0);
  });
  res.json(list.map(view));
});

app.post('/api/schedules', wrap((req, res) => {
  const data = validate(req.body);
  const s = { id: newId(), ownerId: req.user.id, ...data, active: true, status: 'pendiente', createdAt: new Date().toISOString(), createdBy: req.user.name };
  s.nextRun = schedulePlan(s);
  if (!s.nextRun) throw new Error('La fecha y hora ya pasaron. Elegí un momento futuro.');
  s.attachment = saveAttachment(req.body.attachment);
  db.schedules.push(s);
  save();
  res.json(view(s));
}));

app.put('/api/schedules/:id', wrap((req, res) => {
  const s = findMine(req, db.schedules, req.params.id, 'Envío');
  if (s.status === 'enviando') throw new Error('Se está enviando ahora; esperá a que termine');
  const data = validate({ ...req.body, keepAttachment: req.body.keepAttachment && s.attachment });
  Object.assign(s, data, { updatedBy: req.user.name });
  if (req.body.attachment) s.attachment = saveAttachment(req.body.attachment);
  else if (!req.body.keepAttachment) s.attachment = undefined;
  s.nextRun = schedulePlan(s);
  if (!s.nextRun) throw new Error('La fecha y hora ya pasaron. Elegí un momento futuro.');
  s.active = true;
  s.status = 'pendiente';
  save();
  res.json(view(s));
}));

app.post('/api/schedules/:id/toggle', wrap((req, res) => {
  const s = findMine(req, db.schedules, req.params.id, 'Envío');
  if (s.active) {
    s.active = false;
    s.status = 'pausado';
  } else {
    s.nextRun = schedulePlan(s);
    if (!s.nextRun) throw new Error('Ese envío ya pasó. Editalo para elegir una fecha nueva.');
    s.active = true;
    s.status = 'pendiente';
  }
  save();
  res.json(view(s));
}));

app.post('/api/schedules/:id/send-now', wrap(async (req, res) => {
  const s = findMine(req, db.schedules, req.params.id, 'Envío');
  if (!isConnected(req.user.id)) throw new Error('Tu WhatsApp no está conectado');
  if (s.status === 'enviando') throw new Error('Ya se está enviando');
  const prev = s.status;
  runSchedule(s, { manual: true, by: req.user.name }).finally(() => { s.status = s.active ? 'pendiente' : prev; save(); });
  res.json({ ok: true });
}));

app.delete('/api/schedules/:id', (req, res) => {
  const s = db.schedules.find((x) => x.id === req.params.id && x.ownerId === req.user.id);
  if (s?.attachment?.path) fs.rmSync(s.attachment.path, { force: true });
  db.schedules = db.schedules.filter((x) => x !== s);
  save();
  res.json({ ok: true });
});

// ---------- Historial ----------
app.get('/api/history', (req, res) => res.json(db.history.filter(mine(req)).slice(0, 300)));
app.delete('/api/history', (req, res) => { db.history = db.history.filter((h) => h.ownerId !== req.user.id); save(); res.json({ ok: true }); });

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Programador de WhatsApp funcionando');
  console.log(`  Abrí en el navegador:  http://localhost:${PORT}`);
  console.log('  (Dejá esta ventana abierta para que se envíen los mensajes)');
  console.log('');
});

startScheduler();
if (process.env.SIN_WHATSAPP !== '1') startSavedSessions();
