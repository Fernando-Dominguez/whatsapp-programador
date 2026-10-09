// Avisos entrantes: permite que otros sistemas (ej. Fluent Forms en marielakreimer.com)
// pidan "mandá este WhatsApp ya" mediante un POST protegido con una clave.
//
// Configuración (variables de entorno, en el VPS: /etc/whatsapp-programador.env):
//   AVISOS_CLAVE    clave secreta que debe venir en el encabezado X-Api-Key (obligatoria;
//                   sin ella la entrada queda desactivada)
//   AVISOS_USUARIO  usuario del panel cuyo WhatsApp hace el envío (ej. fernando)
//   AVISOS_DESTINO  número que recibe los avisos (ej. 11 2345 6789)
//
// Uso:  POST /hooks/aviso   (encabezado  X-Api-Key: <AVISOS_CLAVE>)
//   Cuerpo JSON o de formulario. Campos especiales (todos opcionales):
//     titulo   primera línea del mensaje, en negrita
//     texto    mensaje ya armado (si viene, se manda tal cual en lugar de la lista de campos)
//     destino  número al que mandar (si no viene, AVISOS_DESTINO)
//   Cualquier otro campo se lista como "Campo: valor", en el orden recibido.
import crypto from 'node:crypto';
import express from 'express';
import db, { addHistory } from './db.js';
import { isConnected, resolvePhoneJid, sendTo, normalizePhone } from './whatsapp.js';

const ESPECIALES = new Set(['titulo', 'texto', 'destino']);
const MAX_VALOR = 1500;

function claveValida(recibida) {
  const esperada = process.env.AVISOS_CLAVE || '';
  if (!esperada || !recibida) return false;
  const a = Buffer.from(String(recibida));
  const b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const etiqueta = (k) => {
  const t = String(k).replace(/[_\-.]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function aTexto(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(aTexto).filter(Boolean).join(', ');
  if (typeof v === 'object') return Object.values(v).map(aTexto).filter(Boolean).join(' ');
  return String(v).trim();
}

/** Arma el mensaje de WhatsApp a partir de los campos recibidos. */
export function armarMensaje(body = {}) {
  if (aTexto(body.texto)) return aTexto(body.texto).slice(0, 4000);
  const lineas = [];
  if (aTexto(body.titulo)) lineas.push(`*${aTexto(body.titulo)}*`, '');
  for (const [k, v] of Object.entries(body)) {
    if (ESPECIALES.has(k)) continue;
    const valor = aTexto(v);
    if (!valor) continue;
    const corto = valor.length > MAX_VALOR ? valor.slice(0, MAX_VALOR) + '…' : valor;
    lineas.push(`*${etiqueta(k)}:* ${corto}`);
  }
  return lineas.join('\n').trim();
}

export function avisosRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: true, limit: '1mb' }));

  r.post('/aviso', async (req, res) => {
    const clave = req.get('x-api-key') || req.query.clave;
    if (!claveValida(clave)) return res.status(401).json({ error: 'Clave inválida o avisos desactivados' });

    const usuario = db.users?.find((u) => u.username === process.env.AVISOS_USUARIO);
    const ownerId = usuario ? usuario.id : 'local';
    const body = req.body || {};
    const destino = normalizePhone(aTexto(body.destino) || process.env.AVISOS_DESTINO);
    const titulo = aTexto(body.titulo) || 'Aviso externo';
    const texto = armarMensaje(body);

    if (!destino || destino.length < 8) return res.status(400).json({ error: 'Falta el número de destino (AVISOS_DESTINO)' });
    if (!texto) return res.status(400).json({ error: 'El aviso llegó vacío' });

    try {
      if (!isConnected(ownerId)) throw new Error('El WhatsApp que envía los avisos no está conectado');
      const jid = await resolvePhoneJid(ownerId, destino);
      await sendTo(ownerId, jid, texto);
      addHistory({ ownerId, title: `Aviso: ${titulo}`, to: destino, ok: true, by: 'Aviso externo' });
      res.json({ ok: true });
    } catch (e) {
      addHistory({ ownerId, title: `Aviso: ${titulo}`, to: destino, ok: false, error: e.message, by: 'Aviso externo' });
      res.status(503).json({ error: e.message });
    }
  });

  return r;
}
