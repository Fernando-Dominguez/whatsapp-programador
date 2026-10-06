# Programador de WhatsApp

App para programar mensajes de WhatsApp desde tu propio número: a personas, grupos o listas de contactos, una vez o de forma recurrente.

## Cómo usarla (Windows)

1. Descomprimí la carpeta donde quieras (por ejemplo, en Documentos).
2. Hacé doble clic en **`iniciar.bat`**.
   - La primera vez instala lo necesario (si no tenés Node.js, intenta instalarlo solo; después cerrá y volvé a abrir `iniciar.bat`).
3. Se abre el navegador en **http://localhost:3000**.
4. En el teléfono: WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo** → escaneá el QR.
5. Listo. **Dejá la ventana negra abierta**: mientras esté abierta y la compu prendida, los mensajes se envían a la hora programada.

## Qué podés hacer

- **Nuevo envío**: elegí destinatarios (personas, grupos o listas), escribí el mensaje, adjuntá una imagen, un PDF, un video o un audio si querés, y elegí la fecha y la repetición (una vez, diaria, de lunes a viernes, semanal o mensual).
- **{nombre}** en el mensaje se reemplaza por el primer nombre de cada persona; **{nombre_completo}**, por el nombre completo.
- **Listas**: pegá contactos desde Excel o Google Sheets (nombre y teléfono).
- **Programados**: editar, pausar, enviar ahora o eliminar.
- **Historial**: qué se envió, a quién y si hubo errores.

## Cosas para saber

- **Teléfonos**: podés escribirlos como quieras (`11 2345 6789`, `+54 9 11 2345-6789`, `011 15 2345 6789`); se convierten solos al formato de WhatsApp. Para números de otros países, poné el código de país (`+34 ...`).
- **Si la compu estaba apagada** a la hora de un envío: si vuelve a prenderse dentro de las 2 horas siguientes, se manda igual; si pasó más tiempo, se marca como *Omitido* (para no mandar un recordatorio tarde). En los envíos recurrentes, sigue con el próximo.
- **Entre mensaje y mensaje** de un mismo envío hay una pausa de 6 a 15 segundos, para que no parezca spam.
- **Riesgo de bloqueo**: esto funciona como WhatsApp Web (no es la API oficial). Para alumnos y clientes que te tienen agendado no hay problema. Evitá mandar a cientos de números que no te conocen.
- **Tus datos** quedan en la carpeta `data` (sesión de WhatsApp, listas, envíos). No la compartas: con esa carpeta se puede usar tu WhatsApp.

## Ajustes opcionales

Se pueden cambiar con variables de entorno antes de `node server.js`:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `PORT` | 3000 | Puerto del panel |
| `MAX_ATRASO_MINUTOS` | 120 | Atraso máximo para mandar un envío pendiente |
| `PAUSA_MIN_SEG` / `PAUSA_MAX_SEG` | 6 / 15 | Pausa entre mensajes |
| `TZ` | America/Argentina/Buenos_Aires | Zona horaria |
| `HOST` | 127.0.0.1 | Usar `0.0.0.0` en un servidor (ver abajo) |

## En un servidor (VPS con Ubuntu) — funciona 24/7

En la terminal del VPS (hPanel → VPS → Terminal del navegador), como root:

```bash
git clone https://github.com/Fernando-Dominguez/whatsapp-programador.git
bash whatsapp-programador/instalar.sh
```

El instalador pregunta:
- **Subdominio** (ej. `whatsapp.fernandominguez.com.ar`): activa https automático. Antes, en hPanel → Dominios → DNS, creá un registro **A** con nombre `whatsapp` apuntando a la IP del VPS.
- **Usuario y contraseña del administrador** para entrar al panel.

Después entrás al panel, vas a **Conexión** y escaneás el QR con el teléfono (solo la primera vez).

**Actualizar** a una versión nueva (conserva datos, usuarios y sesión de WhatsApp):

```bash
cd whatsapp-programador && git pull && bash instalar.sh
```

**Comandos útiles:**
- Ver qué está haciendo: `journalctl -u whatsapp-programador -f`
- Reiniciar: `systemctl restart whatsapp-programador`
- Los datos están en `/var/lib/whatsapp-programador` (hacé copia de esa carpeta si querés respaldo).

## Usuarios

- **Administrador:** todo, más crear usuarios, vincular/desvincular WhatsApp y borrar el historial.
- **Usuario:** programa envíos, arma listas y ve el historial.
- Todos envían desde el mismo WhatsApp vinculado. El historial y los envíos muestran quién los creó.
- En tu compu (Windows), mientras no crees ningún usuario, el panel abre sin contraseña (solo desde esa misma compu).
