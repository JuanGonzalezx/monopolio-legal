// Monopolio Legal — servidor local (Mac) para jugar desde celulares en la misma red.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
const NUM_TEAMS = Number(process.env.EQUIPOS || 10);
const DATA_DIR = path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'partida.json');
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------- Tablero
const AREAS = {
  contratos: { name: 'Contratos', color: '#4E9F5B', price: 100 },
  litigios: { name: 'Litigios', color: '#D1495B', price: 150 },
  cumplimiento: { name: 'Cumplimiento', color: '#3D6FB0', price: 200 },
  infotec: { name: 'Información y tecnología', color: '#E0A526', price: 250 },
};
const BOARD = [
  { type: 'inicio', name: 'Inicio', short: 'INICIO' },
  { type: 'proyecto', area: 'contratos', name: 'Contrato de proveedor', short: 'Proveedor' },
  { type: 'evento', name: 'Evento del director', short: 'Evento' },
  { type: 'proyecto', area: 'contratos', name: 'Contrato laboral', short: 'Laboral' },
  { type: 'proyecto', area: 'contratos', name: 'Acuerdo de confidencialidad', short: 'Confidenc.' },
  { type: 'demanda', name: 'Demanda', short: 'DEMANDA' },
  { type: 'sancion', name: 'Sanción', short: 'SANCIÓN' },
  { type: 'proyecto', area: 'litigios', name: 'Demanda de un cliente', short: 'Dem. cliente' },
  { type: 'evento', name: 'Evento del director', short: 'Evento' },
  { type: 'proyecto', area: 'litigios', name: 'Defensa laboral', short: 'Def. laboral' },
  { type: 'proyecto', area: 'litigios', name: 'Conciliación', short: 'Concilia.' },
  { type: 'diagnostico', name: 'Diagnóstico', short: 'DIAGNÓST.' },
  { type: 'cafe', name: 'Café con el cliente', short: 'CAFÉ' },
  { type: 'proyecto', area: 'cumplimiento', name: 'Requerimiento de la autoridad', short: 'Autoridad' },
  { type: 'evento', name: 'Evento del director', short: 'Evento' },
  { type: 'proyecto', area: 'cumplimiento', name: 'Protección de datos', short: 'Datos pers.' },
  { type: 'proyecto', area: 'cumplimiento', name: 'Licencias y permisos', short: 'Licencias' },
  { type: 'recorte', name: 'Recorte de presupuesto', short: 'RECORTE' },
  { type: 'vaya_sancion', name: 'Vaya a Sanción', short: 'A SANCIÓN' },
  { type: 'proyecto', area: 'infotec', name: 'Archivo de expedientes', short: 'Archivo' },
  { type: 'evento', name: 'Evento del director', short: 'Evento' },
  { type: 'proyecto', area: 'infotec', name: 'Software de contratos', short: 'Software' },
  { type: 'proyecto', area: 'infotec', name: 'Tablero de KPIs', short: 'KPIs' },
  { type: 'demanda', name: 'Demanda', short: 'DEMANDA' },
];
BOARD.forEach((t, i) => { if (t.type === 'proyecto') t.price = AREAS[t.area].price; t.i = i; });
const PLAYER_COLORS = ['#E4572E', '#2E86AB', '#8E44AD', '#2A9D8F'];
const START_MONEY = 1000, PASS_START = 200, OFFICE_COST = 100;

// ---------------------------------------------------------------- Preguntas
let QB = loadQuestions();
function loadQuestions() {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'preguntas.json'), 'utf8'));
  const byId = {};
  for (const [tile, cards] of Object.entries(raw.proyectos))
    for (const [k, q] of Object.entries(cards)) byId[`p${tile}${k}`] = { ...q, id: `p${tile}${k}`, cat: BOARD[tile].name };
  const pools = {};
  for (const [cat, list] of Object.entries(raw.generales)) {
    const label = { alerta: 'Señales de alerta', kpi: 'Datos e indicadores', info: 'Información y conocimiento', autoridad: 'Clientes y autoridad' }[cat] || cat;
    pools[cat] = list.map((q, i) => { const id = `g_${cat}_${i}`; byId[id] = { ...q, id, cat: label }; return id; });
  }
  return { byId, pools };
}

// ---------------------------------------------------------------- Estado
let state = freshState();
function freshState() {
  return { status: 'lobby', durationMin: 40, startedAt: null, endsAt: null, games: {}, log: [] };
}
try {
  if (fs.existsSync(SAVE_FILE)) { state = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); console.log('↺ Partida recuperada de data/partida.json'); }
} catch (e) { console.log('No se pudo leer la partida guardada, se inicia nueva.'); }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(SAVE_FILE, JSON.stringify(state), () => {}), 400);
}

const rnd = (n) => Math.floor(Math.random() * n);
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('es-CO');

function newGame(team, names) {
  return {
    team, phase: 'roll', turn: 0, turns: 0, dice: null, pending: null,
    players: names.map((name, i) => ({ name, color: PLAYER_COLORS[i], money: START_MONEY, pos: 0, jailed: false, pistas: 0, correct: 0, wrong: 0 })),
    owners: {}, used: {}, feed: [],
  };
}
function feed(g, text) { g.feed.unshift({ ts: Date.now(), text }); g.feed = g.feed.slice(0, 12); }
function areaComplete(g, tile) {
  const area = BOARD[tile].area, o = g.owners[tile];
  return BOARD.filter((t) => t.area === area).every((t) => g.owners[t.i] && g.owners[t.i].player === o.player);
}
function rent(g, tile) {
  const o = g.owners[tile];
  return (BOARD[tile].price / 2) * (areaComplete(g, tile) ? 2 : 1) * [1, 2, 3][o.offices];
}
function patrimonio(g, pi) {
  let v = g.players[pi].money;
  for (const [t, o] of Object.entries(g.owners)) if (o.player === pi) v += BOARD[t].price + o.offices * OFFICE_COST;
  return v;
}
function pickGeneral(g, cat) {
  const pool = QB.pools[cat];
  g.used[cat] = g.used[cat] || [];
  let avail = pool.filter((id) => !g.used[cat].includes(id));
  if (!avail.length) { g.used[cat] = []; avail = pool; }
  const id = avail[rnd(avail.length)];
  g.used[cat].push(id);
  return id;
}
function makeQuestion(g, qid, who, reason, ctx, title) {
  const q = QB.byId[qid];
  const order = shuffle([0, 1, 2]);
  return { kind: 'question', qid, who, reason, ctx: ctx || {}, title, text: q.q, options: order.map((i) => q.o[i]), correctIdx: order.indexOf(q.a), eliminated: [] };
}
function info(title, text, next = null, tone = 'neutral') { return { kind: 'info', title, text, next, tone }; }

// --------------------------------------------------- Resolución de casillas
function resolveTile(g) {
  const pi = g.turn, p = g.players[pi], t = BOARD[p.pos];
  switch (t.type) {
    case 'proyecto': {
      const o = g.owners[t.i];
      const label = `${t.name} · ${AREAS[t.area].name} (${money(t.price)})`;
      if (!o) return makeQuestion(g, `p${t.i}A`, pi, 'adquirir', { tile: t.i }, `Adquirir proyecto: ${label}`);
      if (o.player === pi) {
        if (o.offices >= 2) return info('Proyecto blindado 🛡️', `${t.name} ya tiene 2 oficinas. Nadie te lo puede quitar.`);
        if (p.money < OFFICE_COST) return info('Tu proyecto', `Caíste en ${t.name}, pero no tienes ${money(OFFICE_COST)} para una oficina.`);
        return { kind: 'build', tile: t.i, title: `Tu proyecto: ${t.name}`, text: `¿Construir una oficina? Debes responder bien la carta "Mejorar" y pagar ${money(OFFICE_COST)}. Con 2 oficinas el proyecto queda blindado.` };
      }
      return makeQuestion(g, `p${t.i}B`, o.player, 'ejecutar', { tile: t.i, visitor: pi, owner: o.player },
        `${p.name} cayó en "${t.name}" de ${g.players[o.player].name}. El dueño responde la carta "Ejecutar".`);
    }
    case 'evento': return evento(g);
    case 'demanda': {
      const targets = Object.entries(g.owners).filter(([, o]) => o.player !== pi && o.offices < 2).map(([ti]) => Number(ti));
      if (!targets.length) return info('Demanda ⚖️', 'No hay proyectos rivales que se puedan demandar. ¡Te salvaste esta vez!');
      return { kind: 'demanda', targets, title: 'Demanda ⚖️', text: 'Elige un proyecto rival para demandarlo. Si su dueño responde mal y tú respondes bien, te lo quedas. Si el dueño acierta, le pagas $100.' };
    }
    case 'diagnostico':
      p.pistas++;
      return info('Diagnóstico 🔍', `${p.name} hizo un diagnóstico y gana un comodín PISTA (elimina una opción incorrecta). Diagnosticar antes de actuar siempre paga.`, null, 'good');
    case 'recorte':
      return makeQuestion(g, pickGeneral(g, 'kpi'), pi, 'recorte', {}, 'Recorte de presupuesto ✂️ — Demuestra tu valor con datos o pagas $150');
    case 'cafe':
      p.money += 50;
      return info('Café con el cliente ☕', `Buena relación con el cliente: ${p.name} gana $50. La experiencia del cliente es el corazón del servicio legal.`, null, 'good');
    case 'vaya_sancion':
      p.pos = 6; p.jailed = true;
      return info('¡A Sanción! 🚨', `${p.name} incumplió y va a Sanción. En su próximo turno debe responder una pregunta de señales de alerta (si falla paga $100).`, null, 'bad');
    case 'sancion': return info('Sanción (de visita)', 'Solo estás de visita. Aquí terminan quienes incumplen.');
    case 'inicio': return info('Inicio', 'Nuevo año fiscal.');
  }
  return info('', '');
}

const EVENTS = ['martinez', 'dato', 'software', 'stopper', 'ingeniero', 'autoridad', 'procesos'];
function evento(g) {
  const pi = g.turn, p = g.players[pi];
  const ev = EVENTS[rnd(EVENTS.length)];
  const T = 'Evento del director 📢';
  switch (ev) {
    case 'martinez': return makeQuestion(g, pickGeneral(g, 'info'), pi, 'ev_martinez', {}, `${T}: ¡Renunció el abogado Martínez! Responde bien o pierdes un proyecto sin oficinas.`);
    case 'dato': return makeQuestion(g, pickGeneral(g, 'kpi'), pi, 'ev_dato', {}, `${T}: Dato urgente. El director quiere números ya. Si aciertas ganas $150.`);
    case 'autoridad': return makeQuestion(g, pickGeneral(g, 'autoridad'), pi, 'ev_autoridad', {}, `${T}: Requerimiento de la autoridad. Responde bien o pagas $150.`);
    case 'software':
      if (p.pistas > 0) { p.pistas--; p.money += 300; return info(T, `Software milagroso 💻: como ${p.name} hizo diagnóstico (gasta 1 PISTA), el software sí se ajusta a sus procesos. ¡Gana $300!`, null, 'good'); }
      p.money -= 200; return info(T, `Software milagroso 💻: ${p.name} lo compró sin diagnóstico y nadie lo sabe usar. Pierde $200. Es como comprar un carro que no cabe en el garaje.`, null, 'bad');
    case 'stopper': {
      const others = g.players.filter((_, i) => i !== pi);
      others.forEach((o) => { o.money += 50; p.money -= 50; });
      return info(T, `¡Te llaman "stopper"! 🛑 Las otras áreas se quejan de ${p.name}. Paga $50 a cada jugador. Cuida la experiencia del cliente interno.`, null, 'bad');
    }
    case 'ingeniero':
      p.pistas++; return info(T, `Llega un ingeniero al equipo 👷: ${p.name} gana un comodín PISTA. La mitad del staff legal no serán abogados.`, null, 'good');
    case 'procesos':
      p.money += 100; return info(T, `${p.name} organizó sus procesos antes de automatizar ⚙️. El director lo premia con $100.`, null, 'good');
  }
}

// --------------------------------------------------------- Respuestas
function onAnswer(g, pend, ok) {
  const P = g.players, c = pend.ctx;
  const who = P[pend.who];
  let effect = '', next = null;
  switch (pend.reason) {
    case 'adquirir': {
      const t = BOARD[c.tile];
      if (!ok) { effect = `El proyecto "${t.name}" sigue libre.`; break; }
      if (who.money < t.price) { effect = `¡Bien! Pero no tienes ${money(t.price)} para comprarlo.`; break; }
      next = { kind: 'buy', tile: c.tile, title: `Comprar "${t.name}"`, text: `¿Quieres comprarlo por ${money(t.price)}? Cobrarás honorarios a quien caiga aquí.` };
      effect = 'Puedes comprar el proyecto.'; break;
    }
    case 'ejecutar': {
      const t = BOARD[c.tile], v = P[c.visitor], o = P[c.owner];
      if (ok) { const r = rent(g, c.tile); v.money -= r; o.money += r; effect = `${o.name} gestiona bien su proyecto. ${v.name} le paga ${money(r)} de honorarios.`; feed(g, `${v.name} pagó ${money(r)} a ${o.name} por ${t.name}`); break; }
      if (g.owners[c.tile].offices >= 2) { effect = `${o.name} falló, pero el proyecto está blindado. ${v.name} no paga honorarios esta vez.`; break; }
      effect = `${o.name} falló. ¡${v.name} puede robar el proyecto si responde bien!`;
      next = makeQuestion(g, `p${c.tile}C`, c.visitor, 'robo', { tile: c.tile, owner: c.owner }, `¡Oportunidad de robo! ${v.name} responde para quedarse con "${t.name}".`);
      break;
    }
    case 'demanda_owner': {
      const t = BOARD[c.tile], a = P[c.attacker], o = P[c.owner];
      if (ok) { a.money -= 100; o.money += 100; effect = `${o.name} defendió bien su proyecto. ${a.name} le paga $100.`; break; }
      effect = `${o.name} falló. ¡${a.name} puede quedarse con "${t.name}" si responde bien!`;
      next = makeQuestion(g, `p${c.tile}C`, c.attacker, 'robo', { tile: c.tile, owner: c.owner }, `Demanda: ${a.name} responde para quedarse con "${t.name}".`);
      break;
    }
    case 'robo': {
      const t = BOARD[c.tile];
      if (ok) { g.owners[c.tile] = { player: pend.who, offices: 0 }; effect = `¡${who.name} se queda con "${t.name}"! Un proyecto mal gestionado se pierde.`; feed(g, `🔥 ${who.name} le quitó "${t.name}" a ${P[c.owner].name}`); }
      else effect = `Nadie acertó. "${t.name}" sigue siendo de ${P[c.owner].name} y no hay pago.`;
      break;
    }
    case 'mejorar': {
      const t = BOARD[c.tile];
      if (ok) { who.money -= OFFICE_COST; g.owners[c.tile].offices++; const o = g.owners[c.tile].offices; effect = o === 2 ? `¡"${t.name}" queda BLINDADO 🛡️ (2 oficinas)! Ya no se lo pueden quitar.` : `Construiste una oficina en "${t.name}". Sus honorarios se duplican.`; feed(g, `${who.name} construyó oficina en ${t.name}`); }
      else effect = 'No se construye la oficina (no pagas nada).';
      break;
    }
    case 'recorte':
      if (ok) effect = 'Demostraste tu valor con datos. ¡Te salvas del recorte!'; else { who.money -= 150; effect = 'Sin datos no hay cómo defender el presupuesto. Pagas $150.'; }
      break;
    case 'carcel':
      if (ok) effect = '¡Sales de Sanción sin pagar! Ahora tira el dado.'; else { who.money -= 100; effect = 'Pagas $100 para salir de Sanción. Ahora tira el dado.'; }
      who.jailed = false; next = 'roll'; break;
    case 'ev_martinez': {
      if (ok) { effect = 'Tenías la información organizada. ¡No pierdes nada!'; break; }
      const mine = Object.entries(g.owners).filter(([, o]) => o.player === pend.who && o.offices === 0).map(([t]) => t);
      if (!mine.length) { effect = 'Por suerte no tenías proyectos sin oficinas que perder.'; break; }
      const lost = mine[rnd(mine.length)]; delete g.owners[lost];
      effect = `Martínez se llevó la información de "${BOARD[lost].name}". El proyecto vuelve a quedar libre.`; feed(g, `${who.name} perdió ${BOARD[lost].name} (Martínez)`);
      break;
    }
    case 'ev_dato':
      if (ok) { who.money += 150; effect = '¡Respondiste con datos! Ganas $150.'; } else effect = 'Sin datos a la mano no hay premio.';
      break;
    case 'ev_autoridad':
      if (ok) effect = 'Cumpliste con la autoridad a tiempo.'; else { who.money -= 150; effect = 'Incumpliste el requerimiento. Pagas $150.'; }
      break;
  }
  return { effect, next };
}

// ------------------------------------------------------------- Acciones
function endTurn(g) {
  g.turns++; g.turn = (g.turn + 1) % g.players.length; g.pending = null; g.phase = 'roll';
}
function act(team, type, payload = {}) {
  const g = state.games[team];
  if (!g) return 'Partida no encontrada';
  if (state.status === 'lobby') return 'Espera a que el moderador inicie el juego';
  if (state.status === 'paused') return 'El juego está en pausa';
  if (state.status === 'ended' || g.phase === 'ended') return 'El juego terminó';
  const pend = g.pending, p = g.players[g.turn];

  if (type === 'roll') {
    if (g.phase !== 'roll') return 'Ahora no se puede tirar';
    if (p.jailed) { g.pending = makeQuestion(g, pickGeneral(g, 'alerta'), g.turn, 'carcel', {}, `${p.name} está en Sanción 🚨. Responde bien para salir gratis (si fallas pagas $100).`); g.phase = 'action'; return; }
    const d = 1 + rnd(6); g.dice = d;
    const np = p.pos + d;
    let passed = '';
    if (np >= BOARD.length) { p.money += PASS_START; passed = ` Pasó por Inicio: +${money(PASS_START)}.`; }
    p.pos = np % BOARD.length;
    g.lastMove = { player: g.turn, dice: d, tile: p.pos, passed: !!passed };
    g.pending = resolveTile(g); g.phase = 'action';
    g.pending.moveText = `${p.name} sacó ${d} y cayó en "${BOARD[p.pos].name}".${passed}`;
    return;
  }
  if (!pend) return 'No hay nada pendiente';

  if (type === 'answer' && pend.kind === 'question') {
    const idx = Number(payload.idx);
    if (!(idx >= 0 && idx < 3) || pend.eliminated.includes(idx)) return 'Opción inválida';
    const ok = idx === pend.correctIdx;
    const who = g.players[pend.who];
    ok ? who.correct++ : who.wrong++;
    const q = QB.byId[pend.qid];
    state.log.push({ ts: Date.now(), team: g.team, player: who.name, color: who.color, qid: pend.qid, cat: q.cat, question: q.q, chosen: pend.options[idx], correctText: q.o[q.a], correct: ok, reason: pend.reason, pista: pend.eliminated.length > 0 });
    const { effect, next } = onAnswer(g, pend, ok);
    feed(g, `${ok ? '✅' : '❌'} ${who.name} — ${q.cat}`);
    g.pending = { kind: 'result', correct: ok, who: pend.who, question: q.q, chosen: pend.options[idx], correctText: q.o[q.a], explanation: q.e, effect, next };
    return;
  }
  if (type === 'pista' && pend.kind === 'question') {
    const who = g.players[pend.who];
    if (who.pistas <= 0 || pend.eliminated.length) return 'No hay pista disponible';
    const wrong = [0, 1, 2].filter((i) => i !== pend.correctIdx);
    pend.eliminated.push(wrong[rnd(2)]); who.pistas--; return;
  }
  if (type === 'buy' && pend.kind === 'buy') {
    const t = BOARD[pend.tile];
    if (payload.yes && p.money >= t.price && !g.owners[pend.tile]) {
      p.money -= t.price; g.owners[pend.tile] = { player: g.turn, offices: 0 };
      feed(g, `🏢 ${p.name} compró ${t.name}`);
      g.pending = info('¡Proyecto adquirido! 🏢', `${p.name} ahora es dueño de "${t.name}".`, null, 'good');
    } else endTurn(g);
    return;
  }
  if (type === 'build' && pend.kind === 'build') {
    if (!payload.yes) return endTurn(g);
    g.pending = makeQuestion(g, `p${pend.tile}C`, g.turn, 'mejorar', { tile: pend.tile }, `Construir oficina en "${BOARD[pend.tile].name}" — carta "Mejorar"`);
    return;
  }
  if (type === 'demanda' && pend.kind === 'demanda') {
    const tile = Number(payload.tile);
    if (!pend.targets.includes(tile)) return endTurn(g);
    const owner = g.owners[tile].player;
    g.pending = makeQuestion(g, `p${tile}B`, owner, 'demanda_owner', { tile, attacker: g.turn, owner }, `${p.name} demanda "${BOARD[tile].name}". El dueño, ${g.players[owner].name}, se defiende con la carta "Ejecutar".`);
    return;
  }
  if (type === 'continue' && (pend.kind === 'result' || pend.kind === 'info')) {
    const n = pend.next;
    if (n === 'roll') { g.pending = null; g.phase = 'roll'; return; }
    if (n) { g.pending = n; return; }
    return endTurn(g);
  }
  return 'Acción no válida ahora';
}

// --------------------------------------------------------- Vistas públicas
function publicGame(g) {
  if (!g) return null;
  const c = JSON.parse(JSON.stringify(g));
  if (c.pending && c.pending.kind === 'question') delete c.pending.correctIdx;
  if (c.pending && c.pending.next && c.pending.next.correctIdx !== undefined) delete c.pending.next.correctIdx;
  c.players.forEach((p, i) => { p.patrimonio = patrimonio(g, i); });
  return c;
}
function common() {
  return { status: state.status, endsAt: state.endsAt, now: Date.now(), numTeams: NUM_TEAMS, board: BOARD, areas: AREAS,
    teamsTaken: Object.keys(state.games).map(Number) };
}
function lanIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('172.') ? 1 : ip.startsWith('10.') ? 2 : 3);
  return out.sort((a, b) => score(a.ip) - score(b.ip));
}
let joinUrl = '', qrSvg = '';
async function refreshUrl() {
  const ips = lanIPs();
  const url = process.env.URL || `http://${ips[0] ? ips[0].ip : 'localhost'}:${PORT}`;
  if (url !== joinUrl) { joinUrl = url; qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0B1F33', light: '#FFFFFF' } }); broadcast(); }
}
function tvSummary() {
  const teams = [];
  for (let t = 1; t <= NUM_TEAMS; t++) {
    const g = state.games[t];
    if (!g) { teams.push({ team: t, active: false }); continue; }
    const players = g.players.map((p, i) => ({ name: p.name, color: p.color, money: p.money, patrimonio: patrimonio(g, i), correct: p.correct, wrong: p.wrong,
      projects: Object.values(g.owners).filter((o) => o.player === i).length, jailed: p.jailed }));
    const tot = players.reduce((s, p) => s + p.correct + p.wrong, 0), ok = players.reduce((s, p) => s + p.correct, 0);
    const leader = players.reduce((b, p) => (p.patrimonio > b.patrimonio ? p : b), players[0]);
    teams.push({ team: t, active: true, players, leader: leader.name, turnName: g.players[g.turn].name, turns: g.turns, answers: tot, accuracy: tot ? Math.round((ok / tot) * 100) : null, owned: Object.keys(g.owners).length, last: g.feed[0] ? g.feed[0].text : '' });
  }
  // Ranking de jugadores por precisión (mín. 3 respuestas)
  const all = [];
  teams.filter((t) => t.active).forEach((t) => t.players.forEach((p) => all.push({ ...p, team: t.team, total: p.correct + p.wrong })));
  const topAcc = all.filter((p) => p.total >= 3).map((p) => ({ ...p, acc: Math.round((p.correct / p.total) * 100) })).sort((a, b) => b.acc - a.acc || b.correct - a.correct).slice(0, 5);
  const topRich = all.slice().sort((a, b) => b.patrimonio - a.patrimonio).slice(0, 6);
  const qs = {};
  state.log.forEach((l) => { const s = (qs[l.qid] = qs[l.qid] || { question: l.question, cat: l.cat, wrong: 0, total: 0 }); s.total++; if (!l.correct) s.wrong++; });
  const hardest = Object.values(qs).filter((q) => q.wrong > 0).sort((a, b) => b.wrong / b.total - a.wrong / a.total || b.wrong - a.wrong).slice(0, 3);
  const totalAns = state.log.length, totalOk = state.log.filter((l) => l.correct).length;
  return { ...common(), joinUrl, qrSvg, teams, topAcc, topRich, hardest, feed: state.log.slice(-8).reverse(), totals: { answers: totalAns, accuracy: totalAns ? Math.round((totalOk / totalAns) * 100) : null } };
}

// --------------------------------------------------------- HTTP + Sockets
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pin = u.searchParams.get('pin') || req.headers['x-pin'];
  if (u.pathname.startsWith('/api/admin/') || u.pathname === '/export.csv') {
    if (String(pin) !== ADMIN_PIN) return send(res, 401, { error: 'PIN incorrecto' });
    if (u.pathname === '/export.csv') {
      const rows = [['Hora', 'Equipo', 'Jugador', 'Tema', 'Pregunta', 'Respondió', 'Correcta', 'Acertó', 'Situación', 'Usó pista']]
        .concat(state.log.map((l) => [new Date(l.ts).toLocaleTimeString('es-CO'), l.team, l.player, l.cat, l.question, l.chosen, l.correctText, l.correct ? 'Sí' : 'No', l.reason, l.pista ? 'Sí' : 'No']));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="respuestas_monopolio_legal.csv"' });
      return res.end('﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\n'));
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    const a = u.pathname.slice('/api/admin/'.length);
    if (a === 'log') return send(res, 200, { log: state.log.slice().reverse(), status: state.status, endsAt: state.endsAt, durationMin: state.durationMin, games: Object.values(state.games).map((g) => ({ team: g.team, players: g.players.map((p, i) => ({ name: p.name, money: p.money, patrimonio: patrimonio(g, i) })), turns: g.turns })) });
    if (a === 'start') { const m = Number(body.min); state.durationMin = m >= 0 ? m : 40; state.status = 'playing'; state.startedAt = Date.now(); state.endsAt = state.durationMin ? Date.now() + state.durationMin * 60000 : null; }
    else if (a === 'pause') { if (state.status === 'playing') { state.status = 'paused'; state.pausedLeft = state.endsAt ? state.endsAt - Date.now() : null; } }
    else if (a === 'resume') { if (state.status === 'paused') { state.status = 'playing'; if (state.pausedLeft) state.endsAt = Date.now() + state.pausedLeft; } }
    else if (a === 'end') { endAll(); }
    else if (a === 'addtime') { if (state.endsAt) state.endsAt += 5 * 60000; }
    else if (a === 'reset-team') { delete state.games[Number(body.team)]; state.log = state.log.filter((l) => l.team !== Number(body.team)); }
    else if (a === 'skip-turn') { const g = state.games[Number(body.team)]; if (g) endTurn(g); }
    else if (a === 'money') { const g = state.games[Number(body.team)]; const p = g && g.players[Number(body.player)]; if (p) p.money += Number(body.amount) || 0; }
    else if (a === 'reset-all') { state = freshState(); }
    else if (a === 'reload-questions') { try { QB = loadQuestions(); } catch (e) { return send(res, 400, { error: 'preguntas.json tiene un error: ' + e.message }); } }
    else return send(res, 404, { error: 'Acción desconocida' });
    save(); broadcast(); return send(res, 200, { ok: true });
  }
  const routes = { '/': 'index.html', '/tv': 'tv.html', '/admin': 'admin.html' };
  const file = path.join(PUBLIC, routes[u.pathname] || path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'No');
  fs.readFile(file, (err, data) => { if (err) return send(res, 404, 'No encontrado', 'text/plain'); send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream'); });
});

const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });
function emitTeam(t) { io.to('team:' + t).emit('state', { ...common(), game: publicGame(state.games[t]) }); }
let bTimer = null;
function broadcast() {
  clearTimeout(bTimer);
  bTimer = setTimeout(() => {
    for (let t = 1; t <= NUM_TEAMS; t++) emitTeam(t);
    io.to('lobby').emit('state', { ...common(), game: null });
    io.to('tv').emit('tv', tvSummary());
  }, 60);
}
function endAll() {
  state.status = 'ended';
  Object.values(state.games).forEach((g) => { g.phase = 'ended'; g.pending = null; });
}

io.on('connection', (sock) => {
  sock.join('lobby');
  sock.emit('state', { ...common(), game: null });
  sock.on('tv', () => { sock.join('tv'); sock.emit('tv', tvSummary()); });
  sock.on('join', ({ team }) => {
    team = Number(team);
    if (!(team >= 1 && team <= NUM_TEAMS)) return;
    for (const r of sock.rooms) if (r.startsWith('team:')) sock.leave(r);
    sock.join('team:' + team); sock.data.team = team;
    sock.emit('state', { ...common(), game: publicGame(state.games[team]) });
  });
  sock.on('setup', ({ team, names }, cb) => {
    team = Number(team);
    if (state.games[team]) return cb && cb({ error: 'Este equipo ya tiene una partida' });
    names = (names || []).map((n) => String(n).trim().slice(0, 18)).filter(Boolean);
    if (names.length < 2 || names.length > 4) return cb && cb({ error: 'Escriban entre 2 y 4 nombres' });
    state.games[team] = newGame(team, names);
    if (state.status === 'ended') state.games[team].phase = 'ended';
    feed(state.games[team], `Partida creada: ${names.join(', ')}`);
    save(); broadcast(); cb && cb({ ok: true });
  });
  sock.on('action', ({ team, type, payload }, cb) => {
    const err = act(Number(team), type, payload);
    if (err) return cb && cb({ error: err });
    save(); broadcast(); cb && cb({ ok: true });
  });
});

setInterval(() => {
  if (state.status === 'playing' && state.endsAt && Date.now() >= state.endsAt) { endAll(); save(); broadcast(); }
}, 1000);
setInterval(refreshUrl, 8000);

server.listen(PORT, '0.0.0.0', async () => {
  await refreshUrl();
  const ips = lanIPs();
  console.log('\n  🎲  MONOPOLIO LEGAL listo\n');
  console.log(`  Celulares:   ${joinUrl}`);
  console.log(`  TV:          http://localhost:${PORT}/tv`);
  console.log(`  Moderador:   http://localhost:${PORT}/admin   (PIN: ${ADMIN_PIN})\n`);
  if (ips.length > 1) console.log('  Otras IPs de esta Mac: ' + ips.slice(1).map((i) => `${i.ip} (${i.name})`).join(', '));
  if (!ips.length) console.log('  ⚠️  No hay red: conecta la Mac al hotspot y el enlace se actualizará solo.');
  console.log('');
});
module.exports = { act, state: () => state };
