// Simula equipos jugando con respuestas al azar para probar el servidor y ver el dashboard lleno.
// Uso: con el servidor corriendo (npm start), en otra terminal: npm run simular
//      Opcional: EQUIPOS=5 SEGUNDOS=60 npm run simular
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const PIN = process.env.ADMIN_PIN || '1234';
const EQUIPOS = Number(process.env.EQUIPOS || 10);
const SEGUNDOS = Number(process.env.SEGUNDOS || 45);
const NOMBRES = ['Ana', 'Luis', 'Sara', 'Juan', 'Vale', 'Pipe', 'Caro', 'Mateo', 'Lina', 'Kevin', 'Laura', 'Tomás', 'Majo', 'Sebas', 'Isa', 'Nico', 'Dani', 'Paula', 'Ale', 'Cami', 'Simón', 'Mía', 'Jero', 'Santi', 'Luisa', 'Felipe', 'Sofi', 'Andrés', 'Darío', 'Manu'];

(async () => {
  const st = await fetch(`${URL}/api/admin/log`, { headers: { 'x-pin': PIN } }).then((r) => r.json()).catch(() => null);
  if (!st || st.error) { console.error('No se pudo conectar al servidor o el PIN es incorrecto. ¿Está corriendo npm start?'); process.exit(1); }
  if (st.status !== 'playing') await fetch(`${URL}/api/admin/start`, { method: 'POST', headers: { 'x-pin': PIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ min: 40 }) });
  console.log(`Simulando ${EQUIPOS} equipos durante ${SEGUNDOS} s… abre ${URL}/tv para verlo`);
  let acciones = 0, errores = 0;
  for (let t = 1; t <= EQUIPOS; t++) {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => {
      s.emit('join', { team: t });
      const names = Array.from({ length: 3 }, (_, i) => NOMBRES[(t * 3 + i) % NOMBRES.length]);
      s.emit('setup', { team: t, names }, () => {});
    });
    let last = null, busy = false;
    s.on('state', (st) => {
      if (!st.game) return; // ignora mensajes generales (sin partida)
      last = st;
      if (busy) return;
      const g0 = st.game;
      if (!g0 || st.status !== 'playing' || g0.phase === 'ended') return;
      busy = true;
      setTimeout(() => {
        const g = last.game; const pd = g.pending;
        if (last.status !== 'playing' || g.phase === 'ended') { busy = false; return; } let type, payload = {};
        if (g.phase === 'roll') type = 'roll';
        else if (!pd) { busy = false; return; }
        else if (pd.kind === 'question') { type = 'answer'; let i; do { i = Math.floor(Math.random() * 3); } while (pd.eliminated.includes(i)); payload = { idx: i }; }
        else if (pd.kind === 'buy') { type = 'buy'; payload = { yes: Math.random() < 0.85 }; }
        else if (pd.kind === 'build') { type = 'build'; payload = { yes: true }; }
        else if (pd.kind === 'demanda') { type = 'demanda'; payload = { tile: pd.targets[0] }; }
        else type = 'continue';
        acciones++;
        s.emit('action', { team: t, type, payload }, (r) => {
          busy = false;
          if (r && r.error) errores++;
          else if (last && last.game && last.game.phase !== 'ended') s.emit('join', { team: t }); // pide estado fresco
        });
      }, 400 + Math.random() * 900);
    });
  }
  setTimeout(() => { console.log(`Listo: ${acciones} acciones, ${errores} errores.`); process.exit(0); }, SEGUNDOS * 1000);
})();
