// Almacenamiento simple en un archivo JSON (data/db.json).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const empty = () => ({ lists: [], schedules: [], history: [] });

let db;
try {
  db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch {
  db = empty();
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 50);
}
export function saveNow() {
  clearTimeout(saveTimer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const newId = () => crypto.randomUUID().slice(0, 8);

export function addHistory(entry) {
  db.history.unshift({ id: newId(), at: new Date().toISOString(), ...entry });
  if (db.history.length > 2000) db.history.length = 2000;
  save();
}

export default db;
