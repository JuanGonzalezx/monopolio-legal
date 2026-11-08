@echo off
REM Windows: doble clic para iniciar Monopolio Legal
cd /d "%~dp0"
where node >nul 2>nul || (echo Falta Node.js. Instalalo desde https://nodejs.org ^(version LTS^) & pause & exit /b 1)
if not exist node_modules (echo Instalando dependencias, solo la primera vez... & call npm install --omit=dev)
node server.js
pause
