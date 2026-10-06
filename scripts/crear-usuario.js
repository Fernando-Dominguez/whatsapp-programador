// Crea (o actualiza la contraseña de) un usuario desde la terminal.
// Uso: node scripts/crear-usuario.js <usuario> "<nombre>" <admin|usuario> [contraseña]
// Si no pasás la contraseña, te la pide (sin mostrarla).
import '../src/tz.js';
import readline from 'node:readline';
import db, { saveNow } from '../src/db.js';
import { createUser, updateUser } from '../src/auth.js';

const [username, name, role = 'usuario', passArg] = process.argv.slice(2);
if (!username) {
  console.log('Uso: node scripts/crear-usuario.js <usuario> "<nombre>" <admin|usuario> [contraseña]');
  process.exit(1);
}

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

let password = passArg;
if (!password) {
  password = await askHidden('Contraseña (mínimo 8 caracteres): ');
  const again = await askHidden('Repetila: ');
  if (password !== again) { console.error('✖ No coinciden.'); process.exit(1); }
}
try {
  const existing = db.users.find((u) => u.username === username.toLowerCase());
  if (existing) {
    updateUser(existing.id, { password, name, role });
    console.log(`✔ Usuario "${existing.username}" actualizado.`);
  } else {
    const u = createUser({ username, name, role, password });
    console.log(`✔ Usuario "${u.username}" creado (${u.role}).`);
  }
  saveNow();
} catch (e) {
  console.error('✖ ' + e.message);
  process.exit(1);
}
