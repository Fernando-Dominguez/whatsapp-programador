// Programador: revisa cada 15 segundos si hay envíos pendientes y los ejecuta.
import db, { save, addHistory } from './db.js';
import { wa, resolvePhoneJid, sendTo } from './whatsapp.js';

// Si la compu estuvo apagada y un envío se atrasó más que esto, no se manda (se marca "omitido").
const MAX_LATE_MIN = Number(process.env.MAX_ATRASO_MINUTOS || 120);
// Pausa aleatoria entre mensajes de un mismo envío (reduce el riesgo de bloqueo).
const DELAY_MIN = Number(process.env.PAUSA_MIN_SEG || 6);
const DELAY_MAX = Number(process.env.PAUSA_MAX_SEG || 15);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randDelay = () => (DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000;

export const REPEAT_LABELS = {
  none: 'Una sola vez',
  daily: 'Todos los días',
  weekdays: 'De lunes a viernes',
  weekly: 'Todas las semanas',
  monthly: 'Todos los meses',
};

/** Calcula la próxima ejecución estrictamente posterior a `after`, respetando día y hora originales. */
export function computeNext(s, after = new Date()) {
  const base = new Date(s.firstRun);
  if (s.repeat === 'none') return base > after ? base : null;
  let n = 0;
  let d = new Date(base);
  while (d <= after || (s.repeat === 'weekdays' && isWeekend(d))) {
    n++;
    d = occurrence(base, s.repeat, n);
    if (n > 100000) return null;
  }
  return d;
}

function isWeekend(d) {
  const w = d.getDay();
  return w === 0 || w === 6;
}

function occurrence(base, repeat, n) {
  const d = new Date(base);
  if (repeat === 'daily' || repeat === 'weekdays') d.setDate(base.getDate() + n);
  else if (repeat === 'weekly') d.setDate(base.getDate() + 7 * n);
  else if (repeat === 'monthly') {
    const day = base.getDate();
    d.setDate(1);
    d.setMonth(base.getMonth() + n);
    const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, dim));
  }
  return d;
}

/** Primera ejecución válida (para "de lunes a viernes" saltea fines de semana). */
export function firstNext(s) {
  const base = new Date(s.firstRun);
  if (s.repeat === 'weekdays' && isWeekend(base)) return computeNext(s, base);
  return base;
}

/** Expande los destinos (personas, grupos, listas) en destinatarios individuales. */
export function expandTargets(targets) {
  const out = [];
  for (const t of targets || []) {
    if (t.type === 'phone') out.push({ kind: 'phone', phone: t.phone, name: t.name || '' });
    else if (t.type === 'group') out.push({ kind: 'group', jid: t.id, name: t.name || 'grupo' });
    else if (t.type === 'list') {
      const list = db.lists.find((l) => l.id === t.id);
      for (const c of list?.contacts || []) out.push({ kind: 'phone', phone: c.phone, name: c.name || '' });
    }
  }
  return out;
}

export function personalize(text, name) {
  const full = (name || '').trim();
  const first = full.split(/\s+/)[0] || '';
  return (text || '')
    .replace(/\{nombre_completo\}/gi, full)
    .replace(/\{nombre\}/gi, first)
    .replace(/ +([,.!?])/g, '$1')
    .replace(/(^|\n)[ ,]+/g, '$1');
}

let running = false;

export async function runSchedule(s, { manual = false, by } = {}) {
  by = by || s.updatedBy || s.createdBy;
  s.status = 'enviando';
  save();
  const recipients = expandTargets(s.targets);
  const seen = new Set();
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    let label = r.name || r.phone || r.jid;
    try {
      const jid = r.kind === 'group' ? r.jid : await resolvePhoneJid(r.phone);
      if (seen.has(jid)) continue;
      seen.add(jid);
      if (r.kind === 'phone') label = r.name ? `${r.name} (${r.phone})` : r.phone;
      if (ok + fail > 0) await sleep(randDelay());
      await sendTo(jid, personalize(s.text, r.kind === 'group' ? '' : r.name), s.attachment);
      ok++;
      addHistory({ scheduleId: s.id, title: s.title, to: label, ok: true, manual, by });
    } catch (e) {
      fail++;
      addHistory({ scheduleId: s.id, title: s.title, to: label, ok: false, error: e.message, manual, by });
    }
  }
  s.lastRun = new Date().toISOString();
  s.lastResult = { ok, fail };
  return { ok, fail };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const due = db.schedules
      .filter((s) => s.active && s.nextRun && new Date(s.nextRun) <= now)
      .sort((a, b) => new Date(a.nextRun) - new Date(b.nextRun));

    for (const s of due) {
      const lateMin = (Date.now() - new Date(s.nextRun)) / 60000;
      if (lateMin > MAX_LATE_MIN) {
        addHistory({
          scheduleId: s.id,
          title: s.title,
          to: '—',
          ok: false,
          error: `Omitido: estaba programado para ${new Date(s.nextRun).toLocaleString('es-AR')} y la app no estaba funcionando`,
        });
        advance(s, 'omitido');
        continue;
      }
      if (wa.status !== 'conectado') {
        if (s.status !== 'esperando-conexion') {
          s.status = 'esperando-conexion';
          save();
        }
        continue;
      }
      await runSchedule(s);
      advance(s, s.lastResult.fail && !s.lastResult.ok ? 'error' : 'enviado');
    }
  } catch (e) {
    console.error('Error en el programador:', e);
  } finally {
    running = false;
  }
}

function advance(s, doneStatus) {
  const next = s.repeat === 'none' ? null : computeNext(s, new Date());
  s.nextRun = next ? next.toISOString() : null;
  if (!next) s.active = false;
  s.status = next ? 'pendiente' : doneStatus;
  save();
}

export function startScheduler() {
  // Si la app se cerró en medio de un envío, lo deja listo para reintentar.
  for (const s of db.schedules) if (s.status === 'enviando') s.status = 'pendiente';
  save();
  setInterval(tick, 15000);
  setTimeout(tick, 3000);
}
