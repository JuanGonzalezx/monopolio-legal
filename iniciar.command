#!/bin/bash
# macOS: doble clic para iniciar Monopolio Legal (mantiene la Mac despierta)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Falta Node.js. Instálalo desde https://nodejs.org (versión LTS)"; read -p "Enter para salir"; exit 1; fi
if [ ! -d node_modules ]; then echo "Instalando dependencias (solo la primera vez, necesita internet)…"; npm install --omit=dev || { read -p "Error instalando. Enter para salir"; exit 1; }; fi
caffeinate -dimsu node server.js
