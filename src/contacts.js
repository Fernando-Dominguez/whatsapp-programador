// Contactos de WhatsApp de cada usuario, para buscarlos por nombre en el panel.
// WhatsApp se los pasa al dispositivo vinculado (como a WhatsApp Web) al vincularlo,
// y después llegan actualizaciones y los nombres de quienes te escriben.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const DIR = path.join(DATA_DIR, 'contactos');
fs.mkdirSync(DIR, { recursive: true });

/** userId -> { contacts: { key: {name, notify, phone, lid} }, lidToPn: {lid: pn} } */
const stores = new Map();
const timers = new Map();
const file = (userId) => path.join(DIR, String(userId).replace(/[^\w-]/g, '_') + '.json');

function load(userId) {
  if (stores.has(userId)) return stores.get(userId);
  let data = { contacts: {}, lidToPn: {} };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file(userId), 'utf8')) };
  } catch {
    /* todavía no hay contactos */
  }
  stores.set(userId, data);
  return data;
}

function persist(userId) {
  clearTimeout(timers.get(userId));
  timers.set(userId, setTimeout(() => {
    const tmp = file(userId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stores.get(userId)));
    fs.renameSync(tmp, file(userId));
  }, 2000));
}

const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const isPerson = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid || ''));

/** Agrega o actualiza contactos (formato de Baileys: id, lid, phoneNumber, name, notify...). */
export function upsertContacts(userId, list) {
  const st = load(userId);
  let changed = false;
  for (const c of list || []) {
    const ids = [c.id, c.lid, c.phoneNumber].filter(Boolean);
    if (!ids.some(isPerson)) continue;
    const pnJid = ids.find((j) => j.endsWith('@s.whatsapp.net'));
    const lid = ids.find((j) => j.endsWith('@lid'));
    let phone = pnJid ? digits(pnJid) : (lid && st.lidToPn[lid]) || '';
    if (lid && phone) st.lidToPn[lid] = phone;
    const key = phone || lid;
    if (!key) continue;
    // Si antes lo teníamos solo por LID y ahora sabemos el teléfono, unificar
    const prevByLid = lid && phone && st.contacts[lid];
    const prev = st.contacts[key] || prevByLid || {};
    if (prevByLid) delete st.contacts[lid];
    const next = {
      name: c.name || prev.name || '',
      notify: c.notify || c.verifiedName || prev.notify || '',
      phone: phone || prev.phone || '',
      lid: lid || prev.lid || '',
    };
    if (!next.name && !next.notify && !next.phone) continue;
    if (JSON.stringify(next) !== JSON.stringify(st.contacts[key])) {
      st.contacts[key] = next;
      changed = true;
    }
  }
  if (changed) persist(userId);
}

/** Relaciones LID ↔ teléfono que manda WhatsApp. */
export function addLidMappings(userId, mappings) {
  const st = load(userId);
  let changed = false;
  for (const m of mappings || []) {
    const lid = m.lid || m.lidJid;
    const pn = digits(m.pn || m.pnJid);
    if (!lid || !pn) continue;
    st.lidToPn[lid] = pn;
    if (st.contacts[lid]) {
      st.contacts[pn] = { ...st.contacts[lid], phone: pn, ...(st.contacts[pn] || {}) };
      delete st.contacts[lid];
    }
    changed = true;
  }
  if (changed) persist(userId);
}

export function contactCount(userId) {
  return Object.values(load(userId).contacts).filter((c) => c.phone).length;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Busca por nombre o número. `resolveLid` (opcional) intenta averiguar el teléfono
 * de contactos que WhatsApp mandó solo con su identificador interno (LID).
 */
export async function searchContacts(userId, q, resolveLid) {
  const st = load(userId);
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const qDigits = String(q || '').replace(/\D/g, '');
  const scored = [];
  for (const c of Object.values(st.contacts)) {
    const label = c.name || c.notify;
    const hay = norm(`${c.name} ${c.notify}`);
    const matchText = terms.length && terms.every((t) => hay.includes(t));
    const matchNum = qDigits.length >= 3 && c.phone.includes(qDigits);
    if (terms.length && !matchText && !matchNum) continue;
    if (!label && !c.phone) continue;
    scored.push({ c, starts: norm(label).startsWith(terms[0] || '') ? 0 : 1, saved: c.name ? 0 : 1 });
  }
  scored.sort((a, b) => a.starts - b.starts || a.saved - b.saved || norm(a.c.name || a.c.notify).localeCompare(norm(b.c.name || b.c.notify)));
  const out = [];
  for (const { c } of scored) {
    let phone = c.phone;
    if (!phone && c.lid && resolveLid) {
      phone = (await resolveLid(c.lid).catch(() => null)) || '';
      if (phone) addLidMappings(userId, [{ lid: c.lid, pn: phone }]);
    }
    if (!phone) continue;
    out.push({ name: c.name || c.notify || '', phone, saved: !!c.name });
    if (out.length >= 30) break;
  }
  return out;
}

export function deleteContacts(userId) {
  stores.delete(userId);
  fs.rmSync(file(userId), { force: true });
}
