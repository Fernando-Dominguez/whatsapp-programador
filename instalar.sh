#!/usr/bin/env bash
# Instalador / actualizador del Programador de WhatsApp para Ubuntu (VPS).
# Uso (como root):  bash instalar.sh
# Se puede volver a correr para actualizar: conserva datos, usuarios y configuración.
set -euo pipefail

APP_DIR=/opt/whatsapp-programador
DATA_DIR=/var/lib/whatsapp-programador
ENV_FILE=/etc/whatsapp-programador.env
SVC=whatsapp-programador
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

verde() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
aviso() { printf '\033[1;33m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Correlo como root (o con sudo)."; exit 1; }

verde "Actualizando el sistema e instalando herramientas básicas"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  verde "Instalando Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node $(node -v)"

verde "Copiando la app a $APP_DIR"
id -u whatsapp >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin whatsapp
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude '*.bat' "$SRC_DIR"/ "$APP_DIR"/
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R whatsapp:whatsapp "$DATA_DIR"
chmod 700 "$DATA_DIR"

# ---------- Configuración (solo la primera vez) ----------
if [ ! -f "$ENV_FILE" ]; then
  verde "Configuración inicial"
  echo "¿Vas a usar un subdominio propio con https? (recomendado)"
  echo "Ejemplo: whatsapp.fernandominguez.com.ar  — dejalo vacío para usar la IP sin https."
  read -rp "Subdominio: " DOMINIO
  DOMINIO="$(echo "${DOMINIO:-}" | tr -d '[:space:]' | sed -E 's#^https?://##; s#/.*$##')"
  if [ -n "$DOMINIO" ]; then HOST=127.0.0.1; else HOST=0.0.0.0; fi
  cat > "$ENV_FILE" <<EOF
# Configuración del Programador de WhatsApp
DATA_DIR=$DATA_DIR
PORT=3000
HOST=$HOST
TZ=America/Argentina/Buenos_Aires
SESSION_SECRET=$(openssl rand -hex 32)
DOMINIO=$DOMINIO
EOF
  chmod 600 "$ENV_FILE"
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

# ---------- Servicio (arranca solo y se reinicia si falla) ----------
verde "Creando el servicio del sistema"
cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=Programador de WhatsApp
After=network-online.target
Wants=network-online.target

[Service]
User=whatsapp
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl stop $SVC 2>/dev/null || true

# ---------- Usuario administrador (solo si no hay ninguno) ----------
HAY_USUARIOS=$(sudo -u whatsapp DATA_DIR="$DATA_DIR" node -e "import('./src/db.js').then(m=>console.log((m.default.users||[]).length))")
if [ "$HAY_USUARIOS" = "0" ]; then
  verde "Creá tu usuario administrador para entrar al panel"
  read -rp "Usuario (ej. fernando): " ADM_USER
  read -rp "Tu nombre: " ADM_NAME
  sudo -u whatsapp DATA_DIR="$DATA_DIR" SESSION_SECRET="$SESSION_SECRET" node scripts/crear-usuario.js "$ADM_USER" "$ADM_NAME" admin </dev/tty
fi

systemctl enable --now $SVC

# ---------- https con Caddy ----------
if [ -n "${DOMINIO:-}" ]; then
  if ! command -v caddy >/dev/null; then
    verde "Instalando Caddy (https automático)"
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
  cat > /etc/caddy/Caddyfile <<EOF
$DOMINIO {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
  systemctl reload caddy || systemctl restart caddy
fi

# Firewall: si ufw está activo, abrir lo necesario
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null
  if [ -n "${DOMINIO:-}" ]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; else ufw allow 3000/tcp >/dev/null; fi
fi

sleep 2
IP=$(curl -fsS4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo
if systemctl is-active --quiet $SVC; then
  verde "¡Listo! La app está funcionando."
else
  aviso "La app no arrancó. Mirá el error con:  journalctl -u $SVC -n 50"
  exit 1
fi
if [ -n "${DOMINIO:-}" ]; then
  echo "  Panel:  https://$DOMINIO"
  aviso "  Si todavía no lo hiciste, en hPanel → Dominios → DNS creá un registro A:"
  aviso "  nombre: ${DOMINIO%%.*}   apunta a: $IP   (puede tardar unos minutos en andar)"
else
  echo "  Panel:  http://$IP:3000"
  aviso "  Ojo: sin subdominio la conexión no va cifrada. Conviene configurarlo más adelante."
fi
echo
echo "  Ver qué está pasando:   journalctl -u $SVC -f"
echo "  Reiniciar la app:       systemctl restart $SVC"
echo
