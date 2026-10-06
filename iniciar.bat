@echo off
chcp 65001 >nul
title Programador de WhatsApp
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  No encontre Node.js en esta computadora. Intentando instalarlo...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo  Si se instalo bien, CERRA esta ventana y volve a abrir iniciar.bat.
  echo  Si no, descargalo de https://nodejs.org ^(version LTS^) y volve a intentar.
  pause
  exit /b
)

if not exist node_modules (
  echo  Instalando la app por primera vez ^(tarda un minuto^)...
  call npm install --omit=dev
  if errorlevel 1 (
    echo  Hubo un error instalando. Revisa tu conexion a internet.
    pause
    exit /b
  )
)

start "" http://localhost:3000
node server.js
pause
