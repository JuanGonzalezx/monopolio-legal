// ============================================================
// MONOPOLIO LEGAL
// Servidor local para jugar desde celulares en la misma red.
// Incluye:
// - Partidas independientes por equipo.
// - Seleccion de ficha y color por jugador.
// - Temporizador de 30 segundos por pregunta.
// - Pausa y reanudacion del temporizador.
// - Persistencia de las partidas.
// - Dashboard, moderador y exportacion CSV.
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ------------------------------------------------------------
// Configuracion
// ------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
const NUM_TEAMS = Number(process.env.EQUIPOS || 10);

const DATA_DIR = path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'partida.json');
const PUBLIC = path.join(__dirname, 'public');

const START_MONEY = 1000;
const PASS_START = 200;
const OFFICE_COST = 100;

const QUESTION_TIME_SECONDS = 30;
const QUESTION_TIME_MS = QUESTION_TIME_SECONDS * 1000;

// ------------------------------------------------------------
// Opciones de fichas
//
// La interfaz puede leer estos datos mediante el estado Socket.IO.
// Cada jugador almacena su ficha en player.token.
// ------------------------------------------------------------

const PLAYER_PIECES = [
  { id: 'gavel', name: 'Mazo legal', symbol: '🔨' },
  { id: 'scales', name: 'Balanza', symbol: '⚖️' },
  { id: 'book', name: 'Código legal', symbol: '📚' },
  { id: 'shield', name: 'Escudo', symbol: '🛡️' },
  { id: 'star', name: 'Estrella', symbol: '⭐' }
];

// ------------------------------------------------------------
// Opciones de colores
//
// El cliente debe enviar el id o el hexadecimal elegido.
// Los colores se validan en el servidor.
// ------------------------------------------------------------

const COLOR_OPTIONS = [
  { id: 'blue', name: 'Azul', hex: '#2563EB' },
  { id: 'red', name: 'Rojo', hex: '#DC2626' },
  { id: 'green', name: 'Verde', hex: '#16A34A' },
  { id: 'purple', name: 'Morado', hex: '#9333EA' },
  { id: 'orange', name: 'Naranja', hex: '#EA580C' }
];

// ------------------------------------------------------------
// Tablero
// ------------------------------------------------------------

const AREAS = {
  contratos: {
    name: 'Contratos',
    color: '#4E9F5B',
    price: 100
  },

  litigios: {
    name: 'Litigios',
    color: '#D1495B',
    price: 150
  },

  cumplimiento: {
    name: 'Cumplimiento',
    color: '#3D6FB0',
    price: 200
  },

  infotec: {
    name: 'Información y tecnología',
    color: '#E0A526',
    price: 250
  }
};

const BOARD = [
  { type: 'inicio', name: 'Inicio', short: 'INICIO' },

  {
    type: 'proyecto',
    area: 'contratos',
    name: 'Contrato de proveedor',
    short: 'Proveedor'
  },

  { type: 'evento', name: 'Evento del director', short: 'Evento' },

  {
    type: 'proyecto',
    area: 'contratos',
    name: 'Contrato laboral',
    short: 'Laboral'
  },

  {
    type: 'proyecto',
    area: 'contratos',
    name: 'Acuerdo de confidencialidad',
    short: 'Confidenc.'
  },

  { type: 'demanda', name: 'Demanda', short: 'DEMANDA' },

  { type: 'sancion', name: 'Sanción', short: 'SANCIÓN' },

  {
    type: 'proyecto',
    area: 'litigios',
    name: 'Demanda de un cliente',
    short: 'Dem. cliente'
  },

  { type: 'evento', name: 'Evento del director', short: 'Evento' },

  {
    type: 'proyecto',
    area: 'litigios',
    name: 'Defensa laboral',
    short: 'Def. laboral'
  },

  {
    type: 'proyecto',
    area: 'litigios',
    name: 'Conciliación',
    short: 'Concilia.'
  },

  { type: 'diagnostico', name: 'Diagnóstico', short: 'DIAGNÓST.' },

  { type: 'cafe', name: 'Café con el cliente', short: 'CAFÉ' },

  {
    type: 'proyecto',
    area: 'cumplimiento',
    name: 'Requerimiento de la autoridad',
    short: 'Autoridad'
  },

  { type: 'evento', name: 'Evento del director', short: 'Evento' },

  {
    type: 'proyecto',
    area: 'cumplimiento',
    name: 'Protección de datos',
    short: 'Datos pers.'
  },

  {
    type: 'proyecto',
    area: 'cumplimiento',
    name: 'Licencias y permisos',
    short: 'Licencias'
  },

  {
    type: 'recorte',
    name: 'Recorte de presupuesto',
    short: 'RECORTE'
  },

  {
    type: 'vaya_sancion',
    name: 'Vaya a Sanción',
    short: 'A SANCIÓN'
  },

  {
    type: 'proyecto',
    area: 'infotec',
    name: 'Archivo de expedientes',
    short: 'Archivo'
  },

  { type: 'evento', name: 'Evento del director', short: 'Evento' },

  {
    type: 'proyecto',
    area: 'infotec',
    name: 'Software de contratos',
    short: 'Software'
  },

  {
    type: 'proyecto',
    area: 'infotec',
    name: 'Tablero de KPIs',
    short: 'KPIs'
  },

  { type: 'demanda', name: 'Demanda', short: 'DEMANDA' }
];

BOARD.forEach((tile, i) => {
  if (tile.type === 'proyecto') {
    tile.price = AREAS[tile.area].price;
  }

  tile.i = i;
});

// ------------------------------------------------------------
// Preguntas
// ------------------------------------------------------------

let QB = loadQuestions();

function loadQuestions() {
  const questionsPath = path.join(DATA_DIR, 'preguntas.json');
  const raw = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));

  const byId = {};

  for (const [tile, cards] of Object.entries(raw.proyectos)) {
    for (const [key, question] of Object.entries(cards)) {
      byId[`p${tile}${key}`] = {
        ...question,
        id: `p${tile}${key}`,
        cat: BOARD[tile].name
      };
    }
  }

  const pools = {};

  for (const [cat, list] of Object.entries(raw.generales)) {
    const labels = {
      alerta: 'Señales de alerta',
      kpi: 'Datos e indicadores',
      info: 'Información y conocimiento',
      autoridad: 'Clientes y autoridad'
    };

    const label = labels[cat] || cat;

    pools[cat] = list.map((question, i) => {
      const id = `g_${cat}_${i}`;

      byId[id] = {
        ...question,
        id,
        cat: label
      };

      return id;
    });
  }

  return { byId, pools };
}

// ------------------------------------------------------------
// Estado y persistencia
// ------------------------------------------------------------

let state = freshState();

function freshState() {
  return {
    status: 'lobby',
    durationMin: 40,
    startedAt: null,
    endsAt: null,
    games: {},
    log: []
  };
}

// Recuperar partidas guardadas.
try {
  if (fs.existsSync(SAVE_FILE)) {
    state = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));

    console.log('↺ Partida recuperada de data/partida.json');
  }
} catch (error) {
  console.log(
    'No se pudo leer la partida guardada; se inicia una nueva.',
    error.message
  );

  state = freshState();
}

// Adaptar partidas anteriores a los nuevos campos.
function normalizeLoadedState() {
  if (!state || typeof state !== 'object') {
    state = freshState();
  }

  state.games = state.games || {};
  state.log = Array.isArray(state.log) ? state.log : [];

  for (const [teamKey, game] of Object.entries(state.games)) {
    if (!game || typeof game !== 'object') {
      delete state.games[teamKey];
      continue;
    }

    game.team = Number(game.team || teamKey);
    game.turns = Number(game.turns || 0);
    game.turn = Number(game.turn || 0);

    game.players = Array.isArray(game.players)
      ? game.players
      : [];

    game.owners = game.owners || {};
    game.used = game.used || {};
    game.feed = Array.isArray(game.feed) ? game.feed : [];

    game.players = game.players.map((player, i) => ({
      ...player,

      color:
        player.color ||
        COLOR_OPTIONS[i % COLOR_OPTIONS.length].hex,

      token:
        player.token ||
        PLAYER_PIECES[i % PLAYER_PIECES.length].id,

      tokenChosen:
        state.status !== 'lobby' ||
        Boolean(player.tokenChosen),

      colorChosen:
        state.status !== 'lobby' ||
        Boolean(player.colorChosen),

      correct: Number(player.correct || 0),
      wrong: Number(player.wrong || 0),
      pistas: Number(player.pistas || 0),
      money: Number(
        player.money === undefined
          ? START_MONEY
          : player.money
      )
    }));

    // Al reiniciar el servidor, una pregunta abierta recibe
    // nuevamente 30 segundos para evitar que expire durante
    // el tiempo en que el servidor estuvo apagado.
    if (game.pending && game.pending.kind === 'question') {
      if (state.status === 'paused') {
        const savedRemaining = Number(game.pending.remainingMs);

        const remaining = Number.isFinite(savedRemaining)
          ? Math.max(0, savedRemaining)
          : QUESTION_TIME_MS;

        game.pending.remainingMs = remaining;
        game.pending.deadlineAt = Date.now() + remaining;
      } else {
        game.pending.deadlineAt = Date.now() + QUESTION_TIME_MS;
        delete game.pending.remainingMs;
      }
    }
  }
}

normalizeLoadedState();

let saveTimer = null;

function save() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });

      fs.writeFile(
        SAVE_FILE,
        JSON.stringify(state, null, 2),
        (error) => {
          if (error) {
            console.error(
              'Error guardando la partida:',
              error.message
            );
          }
        }
      );
    } catch (error) {
      console.error(
        'Error preparando el archivo de partida:',
        error.message
      );
    }
  }, 400);
}

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------

const rnd = (n) => Math.floor(Math.random() * n);

const shuffle = (array) => {
  const result = array.slice();

  for (let i = result.length - 1; i > 0; i--) {
    const j = rnd(i + 1);

    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
};

const money = (n) =>
  (n < 0 ? '-$' : '$') +
  Math.abs(n).toLocaleString('es-CO');

function feed(game, text) {
  game.feed.unshift({
    ts: Date.now(),
    text
  });

  game.feed = game.feed.slice(0, 12);
}

// ------------------------------------------------------------
// Creacion de partidas y jugadores
// ------------------------------------------------------------

function newGame(team, names) {
  return {
    team,

    phase: 'roll',
    turn: 0,
    turns: 0,

    dice: null,
    lastMove: null,
    pending: null,

    players: names.map((name, i) => ({
      name,

      color:
        COLOR_OPTIONS[i % COLOR_OPTIONS.length].hex,

      token:
        PLAYER_PIECES[i % PLAYER_PIECES.length].id,

      // Estos campos permiten mostrar en el cliente
      // si el jugador ya personalizó su apariencia.
      tokenChosen: state.status !== 'lobby',
      colorChosen: state.status !== 'lobby',

      money: START_MONEY,
      pos: 0,
      jailed: false,
      pistas: 0,
      correct: 0,
      wrong: 0
    })),

    owners: {},
    used: {},
    feed: []
  };
}

// ------------------------------------------------------------
// Propiedades, honorarios y patrimonio
// ------------------------------------------------------------

function areaComplete(game, tile) {
  const area = BOARD[tile].area;
  const owner = game.owners[tile];

  if (!owner) return false;

  return BOARD
    .filter((t) => t.area === area)
    .every(
      (t) =>
        game.owners[t.i] &&
        game.owners[t.i].player === owner.player
    );
}

function rent(game, tile) {
  const owner = game.owners[tile];

  if (!owner) return 0;

  const multiplier = [1, 2, 3][owner.offices] || 1;

  return (
    (BOARD[tile].price / 2) *
    (areaComplete(game, tile) ? 2 : 1) *
    multiplier
  );
}

function patrimonio(game, playerIndex) {
  let total = game.players[playerIndex].money;

  for (const [tile, owner] of Object.entries(game.owners)) {
    if (owner.player === playerIndex) {
      total += BOARD[tile].price;
      total += owner.offices * OFFICE_COST;
    }
  }

  return total;
}

// ------------------------------------------------------------
// Seleccion de preguntas
// ------------------------------------------------------------

function pickGeneral(game, cat) {
  const pool = QB.pools[cat] || [];

  if (!pool.length) {
    throw new Error(
      `No hay preguntas disponibles para la categoría "${cat}".`
    );
  }

  game.used[cat] = game.used[cat] || [];

  let available = pool.filter(
    (id) => !game.used[cat].includes(id)
  );

  if (!available.length) {
    game.used[cat] = [];
    available = pool;
  }

  const id = available[rnd(available.length)];

  game.used[cat].push(id);

  return id;
}

// Crea la pregunta sin iniciar todavía su temporizador.
// Esto es importante cuando la pregunta está dentro de
// una pantalla de resultado y aún no se ha mostrado.
function makeQuestion(game, qid, who, reason, ctx, title) {
  const question = QB.byId[qid];

  if (!question) {
    throw new Error(`No se encontró la pregunta "${qid}".`);
  }

  const order = shuffle([0, 1, 2]);

  return {
    kind: 'question',
    qid,
    who,
    reason,
    ctx: ctx || {},
    title,

    text: question.q,
    options: order.map((i) => question.o[i]),
    correctIdx: order.indexOf(question.a),

    eliminated: [],

    durationMs: QUESTION_TIME_MS,
    deadlineAt: null
  };
}

// Inicia los 30 segundos únicamente cuando la pregunta
// se convierte en la pantalla activa del equipo.
function armQuestionTimer(pending) {
  if (!pending || pending.kind !== 'question') {
    return;
  }

  pending.durationMs = QUESTION_TIME_MS;
  pending.deadlineAt = Date.now() + QUESTION_TIME_MS;

  delete pending.remainingMs;
}

function info(title, text, next = null, tone = 'neutral') {
  return {
    kind: 'info',
    title,
    text,
    next,
    tone
  };
}

// ------------------------------------------------------------
// Eventos del director
// ------------------------------------------------------------

const EVENTS = [
  'martinez',
  'dato',
  'software',
  'stopper',
  'ingeniero',
  'autoridad',
  'procesos'
];

function evento(game) {
  const playerIndex = game.turn;
  const player = game.players[playerIndex];

  const event = EVENTS[rnd(EVENTS.length)];
  const title = 'Evento del director 📢';

  switch (event) {
    case 'martinez':
      return makeQuestion(
        game,
        pickGeneral(game, 'info'),
        playerIndex,
        'ev_martinez',
        {},
        `${title}: ¡Renunció el abogado Martínez! Responde bien o pierdes un proyecto sin oficinas.`
      );

    case 'dato':
      return makeQuestion(
        game,
        pickGeneral(game, 'kpi'),
        playerIndex,
        'ev_dato',
        {},
        `${title}: Dato urgente. Si aciertas, ganas $150.`
      );

    case 'autoridad':
      return makeQuestion(
        game,
        pickGeneral(game, 'autoridad'),
        playerIndex,
        'ev_autoridad',
        {},
        `${title}: Requerimiento de la autoridad. Responde bien o pagas $150.`
      );

    case 'software':
      if (player.pistas > 0) {
        player.pistas--;
        player.money += 300;

        return info(
          title,
          `Software milagroso: ${player.name} gasta una PISTA y gana $300.`,
          null,
          'good'
        );
      }

      player.money -= 200;

      return info(
        title,
        `Software milagroso: ${player.name} pierde $200 porque lo adquirió sin diagnóstico.`,
        null,
        'bad'
      );

    case 'stopper': {
      const others = game.players.filter(
        (_, i) => i !== playerIndex
      );

      for (const other of others) {
        other.money += 50;
        player.money -= 50;
      }

      return info(
        title,
        `${player.name} paga $50 a cada jugador.`,
        null,
        'bad'
      );
    }

    case 'ingeniero':
      player.pistas++;

      return info(
        title,
        `${player.name} gana un comodín PISTA.`,
        null,
        'good'
      );

    case 'procesos':
      player.money += 100;

      return info(
        title,
        `${player.name} organiza sus procesos y gana $100.`,
        null,
        'good'
      );
  }

  return info(title, 'Evento sin efecto.');
}

// ------------------------------------------------------------
// Resolucion de casillas
// ------------------------------------------------------------

function resolveTile(game) {
  const playerIndex = game.turn;
  const player = game.players[playerIndex];
  const tile = BOARD[player.pos];

  switch (tile.type) {
    case 'proyecto': {
      const owner = game.owners[tile.i];

      const label =
        `${tile.name} · ${AREAS[tile.area].name} (${money(tile.price)})`;

      if (!owner) {
        return makeQuestion(
          game,
          `p${tile.i}A`,
          playerIndex,
          'adquirir',
          { tile: tile.i },
          `Adquirir proyecto: ${label}`
        );
      }

      if (owner.player === playerIndex) {
        if (owner.offices >= 2) {
          return info(
            'Proyecto blindado 🛡️',
            `${tile.name} ya tiene dos oficinas.`
          );
        }

        if (player.money < OFFICE_COST) {
          return info(
            'Tu proyecto',
            `No tienes ${money(OFFICE_COST)} para construir una oficina.`
          );
        }

        return {
          kind: 'build',
          tile: tile.i,
          title: `Tu proyecto: ${tile.name}`,
          text:
            `Responde bien la carta Mejorar y paga ${money(OFFICE_COST)} para construir una oficina.`
        };
      }

      return makeQuestion(
        game,
        `p${tile.i}B`,
        owner.player,
        'ejecutar',
        {
          tile: tile.i,
          visitor: playerIndex,
          owner: owner.player
        },
        `${player.name} cayó en "${tile.name}" de ${game.players[owner.player].name}. El dueño responde la carta Ejecutar.`
      );
    }

    case 'evento':
      return evento(game);

    case 'demanda': {
      const targets = Object.entries(game.owners)
        .filter(([, owner]) =>
          owner.player !== playerIndex &&
          owner.offices < 2
        )
        .map(([tileIndex]) => Number(tileIndex));

      if (!targets.length) {
        return info(
          'Demanda ⚖️',
          'No hay proyectos rivales que se puedan demandar.'
        );
      }

      return {
        kind: 'demanda',
        targets,
        title: 'Demanda ⚖️',
        text:
          'Elige un proyecto rival. Si su dueño responde mal y tú respondes bien, te lo quedas. Si el dueño acierta, le pagas $100.'
      };
    }

    case 'diagnostico':
      player.pistas++;

      return info(
        'Diagnóstico 🔍',
        `${player.name} gana un comodín PISTA que elimina una opción incorrecta.`,
        null,
        'good'
      );

    case 'recorte':
      return makeQuestion(
        game,
        pickGeneral(game, 'kpi'),
        playerIndex,
        'recorte',
        {},
        'Recorte de presupuesto: responde bien para evitar perder $150.'
      );

    case 'cafe':
      player.money += 50;

      return info(
        'Café con el cliente ☕',
        `${player.name} gana $50.`,
        null,
        'good'
      );

    case 'vaya_sancion':
      player.pos = 6;
      player.jailed = true;

      return info(
        '¡A Sanción! 🚨',
        `${player.name} va a Sanción. En su próximo turno deberá responder una pregunta para salir.`,
        null,
        'bad'
      );

    case 'sancion':
      return info(
        'Sanción (de visita)',
        'Solo estás de visita. Aquí terminan quienes incumplen.'
      );

    case 'inicio':
      return info('Inicio', 'Nuevo año fiscal.');
  }

  return info('', '');
}

// ------------------------------------------------------------
// Efectos de las respuestas
// ------------------------------------------------------------

function onAnswer(game, pending, correct) {
  const players = game.players;
  const ctx = pending.ctx;
  const player = players[pending.who];

  let effect = '';
  let next = null;

  switch (pending.reason) {
    case 'adquirir': {
      const tile = BOARD[ctx.tile];

      if (!correct) {
        effect = `El proyecto "${tile.name}" sigue libre.`;
        break;
      }

      if (player.money < tile.price) {
        effect =
          `¡Bien! Pero no tienes ${money(tile.price)} para comprarlo.`;
        break;
      }

      next = {
        kind: 'buy',
        tile: ctx.tile,
        title: `Comprar "${tile.name}"`,
        text:
          `¿Quieres comprarlo por ${money(tile.price)}?`
      };

      effect = 'Puedes comprar el proyecto.';
      break;
    }

    case 'ejecutar': {
      const tile = BOARD[ctx.tile];
      const visitor = players[ctx.visitor];
      const owner = players[ctx.owner];

      if (correct) {
        const amount = rent(game, ctx.tile);

        visitor.money -= amount;
        owner.money += amount;

        effect =
          `${owner.name} gestiona bien su proyecto. ${visitor.name} paga ${money(amount)} de honorarios.`;

        feed(
          game,
          `${visitor.name} pagó ${money(amount)} a ${owner.name} por ${tile.name}`
        );

        break;
      }

      if (game.owners[ctx.tile].offices >= 2) {
        effect =
          `${owner.name} falló, pero el proyecto está blindado. No hay robo ni honorarios esta vez.`;

        break;
      }

      effect =
        `${owner.name} falló. ${visitor.name} puede quedarse con el proyecto si responde bien.`;

      next = makeQuestion(
        game,
        `p${ctx.tile}C`,
        ctx.visitor,
        'robo',
        {
          tile: ctx.tile,
          owner: ctx.owner
        },
        `¡Oportunidad de robo! ${visitor.name} responde para quedarse con "${tile.name}".`
      );

      break;
    }

    case 'demanda_owner': {
      const tile = BOARD[ctx.tile];
      const attacker = players[ctx.attacker];
      const owner = players[ctx.owner];

      if (correct) {
        attacker.money -= 100;
        owner.money += 100;

        effect =
          `${owner.name} defendió bien su proyecto. ${attacker.name} le paga $100.`;

        break;
      }

      effect =
        `${owner.name} falló. ${attacker.name} puede quedarse con "${tile.name}" si responde bien.`;

      next = makeQuestion(
        game,
        `p${ctx.tile}C`,
        ctx.attacker,
        'robo',
        {
          tile: ctx.tile,
          owner: ctx.owner
        },
        `Demanda: ${attacker.name} responde para quedarse con "${tile.name}".`
      );

      break;
    }

    case 'robo': {
      const tile = BOARD[ctx.tile];

      if (correct) {
        game.owners[ctx.tile] = {
          player: pending.who,
          offices: 0
        };

        effect =
          `¡${player.name} se queda con "${tile.name}"!`;

        feed(
          game,
          `🔥 ${player.name} le quitó "${tile.name}" a ${players[ctx.owner].name}`
        );
      } else {
        effect =
          `Nadie acertó. "${tile.name}" sigue siendo de ${players[ctx.owner].name}.`;
      }

      break;
    }

    case 'mejorar': {
      const tile = BOARD[ctx.tile];

      if (correct) {
        player.money -= OFFICE_COST;
        game.owners[ctx.tile].offices++;

        const offices = game.owners[ctx.tile].offices;

        effect =
          offices === 2
            ? `"${tile.name}" queda BLINDADO con dos oficinas.`
            : `Construiste una oficina en "${tile.name}". Sus honorarios se duplican.`;

        feed(
          game,
          `${player.name} construyó una oficina en ${tile.name}`
        );
      } else {
        effect = 'No se construye la oficina y no pagas nada.';
      }

      break;
    }

    case 'recorte':
      if (correct) {
        effect =
          'Demostraste tu valor con datos. Te salvas del recorte.';
      } else {
        player.money -= 150;
        effect =
          'Sin datos no hay cómo defender el presupuesto. Pagas $150.';
      }

      break;

    case 'carcel':
      if (correct) {
        effect = '¡Sales de Sanción sin pagar! Ahora tira el dado.';
      } else {
        player.money -= 100;
        effect = 'Pagas $100 para salir de Sanción. Ahora tira el dado.';
      }

      player.jailed = false;
      next = 'roll';

      break;

    case 'ev_martinez': {
      if (correct) {
        effect = 'Tenías la información organizada. ¡No pierdes nada!';
        break;
      }

      const mine = Object.entries(game.owners)
        .filter(([, owner]) =>
          owner.player === pending.who &&
          owner.offices === 0
        )
        .map(([tile]) => tile);

      if (!mine.length) {
        effect =
          'Por suerte no tenías proyectos sin oficinas que perder.';
        break;
      }

      const lost = mine[rnd(mine.length)];

      delete game.owners[lost];

      effect =
        `Martínez se llevó la información de "${BOARD[lost].name}". El proyecto queda libre.`;

      feed(
        game,
        `${player.name} perdió ${BOARD[lost].name} (Martínez)`
      );

      break;
    }

    case 'ev_dato':
      if (correct) {
        player.money += 150;
        effect = '¡Respondiste con datos! Ganas $150.';
      } else {
        effect = 'Sin datos a la mano no hay premio.';
      }

      break;

    case 'ev_autoridad':
      if (correct) {
        effect = 'Cumpliste con la autoridad a tiempo.';
      } else {
        player.money -= 150;
        effect = 'Incumpliste el requerimiento. Pagas $150.';
      }

      break;
  }

  return { effect, next };
}

// ------------------------------------------------------------
// Procesamiento de respuestas
//
// Este método es compartido por las respuestas normales y
// por el vencimiento del temporizador.
// ------------------------------------------------------------

function answerQuestion(game, pending, selectedIndex, timedOut = false) {
  if (!pending || pending.kind !== 'question') {
    return false;
  }

  const question = QB.byId[pending.qid];

  if (!question) {
    console.error(
      'No se encontró la pregunta al procesar la respuesta:',
      pending.qid
    );

    return false;
  }

  const correct =
    !timedOut &&
    selectedIndex === pending.correctIdx;

  const player = game.players[pending.who];

  if (correct) {
    player.correct++;
  } else {
    player.wrong++;
  }

  const chosen = timedOut
    ? 'Tiempo agotado (30 segundos)'
    : pending.options[selectedIndex];

  const correctText = question.o[question.a];

  state.log.push({
    ts: Date.now(),
    team: game.team,
    player: player.name,
    color: player.color,
    qid: pending.qid,
    cat: question.cat,
    question: question.q,
    chosen,
    correctText,
    correct,
    reason: pending.reason,
    pista: pending.eliminated.length > 0,
    timedOut
  });

  const result = onAnswer(game, pending, correct);

  feed(
    game,
    timedOut
      ? `⏱ Tiempo agotado — ${player.name} — ${question.cat}`
      : `${correct ? '✅' : '❌'} ${player.name} — ${question.cat}`
  );

  game.pending = {
    kind: 'result',
    correct,
    timedOut,

    who: pending.who,
    question: question.q,
    chosen,
    correctText,
    explanation: question.e,

    effect: timedOut
      ? `Se agotaron los 30 segundos. ${result.effect}`
      : result.effect,

    next: result.next
  };

  game.phase = 'action';

  return true;
}

// ------------------------------------------------------------
// Expiracion automatica de una pregunta
// ------------------------------------------------------------

function expireQuestion(game) {
  const pending = game.pending;

  if (!pending || pending.kind !== 'question') {
    return false;
  }

  if (!Number.isFinite(pending.deadlineAt)) {
    const startAt = Number(pending.timerStartsAt);

    if (Number.isFinite(startAt) && Date.now() < startAt) {
      return false;
    }

    delete pending.timerStartsAt;
    armQuestionTimer(pending);

    return true;
  }

  if (Date.now() < pending.deadlineAt) {
    return false;
  }

  return answerQuestion(game, pending, -1, true);
}

// ------------------------------------------------------------
// Finalizacion de turno
// ------------------------------------------------------------

function endTurn(game) {
  game.turns++;

  game.turn =
    (game.turn + 1) % game.players.length;

  game.pending = null;
  game.phase = 'roll';
}

// ------------------------------------------------------------
// Acciones de los equipos
// ------------------------------------------------------------

function act(team, type, payload = {}) {
  const game = state.games[team];

  if (!game) {
    return 'Partida no encontrada';
  }

  // ----------------------------------------------------------
  // Personalizacion de ficha y color
  //
  // Se permite durante la sala de espera y hasta el primer
  // lanzamiento de dados del equipo.
  //
  // El cliente puede enviar:
  // action('customize', {
  //   player: 0,
  //   token: 'shield',
  //   color: '#16A34A'
  // })
  // ----------------------------------------------------------

  if (type === 'customize') {
    if (state.status !== 'lobby') {
      return 'La personalización solo está disponible antes de iniciar el juego';
    }
    if (
      game.phase === 'ended' ||
      state.status === 'ended'
    ) {
      return 'La partida ya terminó';
    }

    if (
      game.turns > 0 ||
      game.lastMove ||
      game.dice !== null ||
      game.phase !== 'roll'
    ) {
      return 'Las fichas y colores solo se pueden cambiar antes del primer lanzamiento';
    }

    const playerIndex = Number(payload.player);

    if (
      !Number.isInteger(playerIndex) ||
      playerIndex < 0 ||
      playerIndex >= game.players.length
    ) {
      return 'Jugador inválido';
    }

    const player = game.players[playerIndex];

    const hasToken =
      payload.token !== undefined &&
      payload.token !== null;

    const hasColor =
      payload.color !== undefined &&
      payload.color !== null;

    if (!hasToken && !hasColor) {
      return 'Debes seleccionar una ficha o un color';
    }

    if (hasToken) {
      const token = String(payload.token);

      const validToken = PLAYER_PIECES.find(
        (piece) => piece.id === token
      );

      if (!validToken) {
        return 'La ficha seleccionada no es válida';
      }

      const usedByOther = game.players.some(
        (other, index) =>
          index !== playerIndex &&
          other.tokenChosen &&
          other.token === token
      );

      if (usedByOther) {
        return 'Esa ficha ya fue elegida por otro jugador';
      }

      player.token = validToken.id;
      player.tokenChosen = true;
    }

    if (hasColor) {
      const selectedColor = String(payload.color)
        .trim()
        .toLowerCase();

      const validColor = COLOR_OPTIONS.find(
        (color) =>
          color.id.toLowerCase() === selectedColor ||
          color.hex.toLowerCase() === selectedColor
      );

      if (!validColor) {
        return 'El color seleccionado no es válido';
      }

      const colorUsedByOther = game.players.some(
        (other, index) =>
          index !== playerIndex &&
          other.colorChosen &&
          String(other.color).toLowerCase() ===
          validColor.hex.toLowerCase()
      );

      if (colorUsedByOther) {
        return 'Ese color ya fue elegido por otro jugador';
      }

      player.color = validColor.hex;
      player.colorChosen = true;
    }

    return;
  }

  // ----------------------------------------------------------
  // Comprobaciones de estado
  // ----------------------------------------------------------

  if (state.status === 'lobby') {
    return 'Espera a que el moderador inicie el juego';
  }

  if (state.status === 'paused') {
    return 'El juego está en pausa';
  }

  if (
    state.status === 'ended' ||
    game.phase === 'ended'
  ) {
    return 'El juego terminó';
  }

  const pending = game.pending;
  const player = game.players[game.turn];

  // Evitar responder antes de que termine la animación del dado.
  if (
    pending &&
    pending.kind === 'question' &&
    !Number.isFinite(pending.deadlineAt)
  ) {
    const startAt = Number(pending.timerStartsAt);

    // Todavía está transcurriendo la animación de dos segundos.
    if (
      Number.isFinite(startAt) &&
      Date.now() < startAt
    ) {
      return 'Espera a que termine el lanzamiento del dado';
    }

    // Comienza oficialmente el temporizador de 30 segundos.
    delete pending.timerStartsAt;
    armQuestionTimer(pending);
  }

  // ----------------------------------------------------------
  // Tirar el dado
  // ----------------------------------------------------------

  if (type === 'roll') {
    if (game.phase !== 'roll') {
      return 'Ahora no se puede tirar';
    }

    if (player.jailed) {
      game.pending = makeQuestion(
        game,
        pickGeneral(game, 'alerta'),
        game.turn,
        'carcel',
        {},
        `${player.name} está en Sanción. Responde bien para salir gratis; si fallas pagas $100.`
      );

      game.phase = 'action';

      armQuestionTimer(game.pending);

      return;
    }

    const dice = 1 + rnd(6);
    game.dice = dice;

    const newPosition = player.pos + dice;

    let passedText = '';

    if (newPosition >= BOARD.length) {
      player.money += PASS_START;

      passedText =
        ` Pasó por Inicio: +${money(PASS_START)}.`;
    }

    player.pos = newPosition % BOARD.length;

    game.lastMove = {
      player: game.turn,
      dice,
      tile: player.pos,
      passed: Boolean(passedText)
    };

    game.pending = resolveTile(game);
    game.phase = 'action';

    game.pending.moveText =
      `${player.name} sacó ${dice} y cayó en "${BOARD[player.pos].name}".${passedText}`;

    // El temporizador comienza cuando aparece una pregunta.
    if (game.pending.kind === 'question') {
      // Espera la animación del dado antes de iniciar
      // los 30 segundos disponibles para responder.
      game.pending.deadlineAt = null;
      game.pending.timerStartsAt = Date.now() + 2200;
    } else {
      armQuestionTimer(game.pending);
    }

    return;
  }

  // ----------------------------------------------------------
  // Validar existencia de accion pendiente
  // ----------------------------------------------------------

  if (!pending) {
    return 'No hay nada pendiente';
  }

  // ----------------------------------------------------------
  // Responder pregunta
  // ----------------------------------------------------------

  if (
    type === 'answer' &&
    pending.kind === 'question'
  ) {
    const index = Number(payload.idx);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= pending.options.length
    ) {
      return 'Opción inválida';
    }

    if (pending.eliminated.includes(index)) {
      return 'Esa opción fue eliminada por la pista';
    }

    answerQuestion(game, pending, index, false);

    return;
  }

  // ----------------------------------------------------------
  // Comodin PISTA
  // ----------------------------------------------------------

  if (
    type === 'pista' &&
    pending.kind === 'question'
  ) {
    const answeringPlayer = game.players[pending.who];

    if (
      answeringPlayer.pistas <= 0 ||
      pending.eliminated.length
    ) {
      return 'No hay pista disponible';
    }

    const wrongOptions = [0, 1, 2].filter(
      (i) => i !== pending.correctIdx
    );

    const eliminatedIndex =
      wrongOptions[rnd(wrongOptions.length)];

    pending.eliminated.push(eliminatedIndex);
    answeringPlayer.pistas--;

    return;
  }

  // ----------------------------------------------------------
  // Comprar proyecto
  // ----------------------------------------------------------

  if (
    type === 'buy' &&
    pending.kind === 'buy'
  ) {
    const tile = BOARD[pending.tile];

    if (
      payload.yes &&
      player.money >= tile.price &&
      !game.owners[pending.tile]
    ) {
      player.money -= tile.price;

      game.owners[pending.tile] = {
        player: game.turn,
        offices: 0
      };

      feed(
        game,
        `🏢 ${player.name} compró ${tile.name}`
      );

      game.pending = info(
        '¡Proyecto adquirido! 🏢',
        `${player.name} ahora es dueño de "${tile.name}".`,
        null,
        'good'
      );
    } else {
      endTurn(game);
    }

    return;
  }

  // ----------------------------------------------------------
  // Mejorar proyecto
  // ----------------------------------------------------------

  if (
    type === 'build' &&
    pending.kind === 'build'
  ) {
    if (!payload.yes) {
      endTurn(game);
      return;
    }

    game.pending = makeQuestion(
      game,
      `p${pending.tile}C`,
      game.turn,
      'mejorar',
      { tile: pending.tile },
      `Construir oficina en "${BOARD[pending.tile].name}" — carta Mejorar`
    );

    armQuestionTimer(game.pending);

    return;
  }

  // ----------------------------------------------------------
  // Demanda
  // ----------------------------------------------------------

  if (
    type === 'demanda' &&
    pending.kind === 'demanda'
  ) {
    const tile = Number(payload.tile);

    if (!pending.targets.includes(tile)) {
      if (tile === -1) {
        endTurn(game);
        return;
      }

      return 'Proyecto inválido para la demanda';
    }

    const owner = game.owners[tile].player;

    game.pending = makeQuestion(
      game,
      `p${tile}B`,
      owner,
      'demanda_owner',
      {
        tile,
        attacker: game.turn,
        owner
      },
      `${player.name} demanda "${BOARD[tile].name}". El dueño, ${game.players[owner].name}, se defiende con la carta Ejecutar.`
    );

    armQuestionTimer(game.pending);

    return;
  }

  // ----------------------------------------------------------
  // Continuar despues del resultado
  // ----------------------------------------------------------

  if (
    type === 'continue' &&
    (
      pending.kind === 'result' ||
      pending.kind === 'info'
    )
  ) {
    const next = pending.next;

    if (next === 'roll') {
      game.pending = null;
      game.phase = 'roll';
      return;
    }

    if (next) {
      game.pending = next;

      // Si aparece otra pregunta encadenada, sus 30 segundos
      // comienzan ahora y no durante la pantalla de resultado.
      armQuestionTimer(game.pending);

      return;
    }

    endTurn(game);

    return;
  }

  return 'Acción no válida ahora';
}

// ------------------------------------------------------------
// Vista publica del juego
//
// Nunca se envía el índice de la respuesta correcta al cliente.
// ------------------------------------------------------------

function publicGame(game) {
  if (!game) return null;

  const copy = JSON.parse(JSON.stringify(game));

  if (
    copy.pending &&
    copy.pending.kind === 'question'
  ) {
    delete copy.pending.correctIdx;
  }

  if (
    copy.pending &&
    copy.pending.next &&
    copy.pending.next.correctIdx !== undefined
  ) {
    delete copy.pending.next.correctIdx;
  }

  copy.players.forEach((player, i) => {
    player.patrimonio = patrimonio(game, i);
  });

  return copy;
}

// ------------------------------------------------------------
// Estado comun para todos los clientes
//
// Se exponen las opciones de fichas y colores para que
// public/index.html pueda crear los selectores visuales.
// ------------------------------------------------------------

function common() {
  return {
    status: state.status,
    endsAt: state.endsAt,
    now: Date.now(),

    numTeams: NUM_TEAMS,

    board: BOARD,
    areas: AREAS,

    pieces: PLAYER_PIECES,
    colors: COLOR_OPTIONS,

    questionTimeSeconds: QUESTION_TIME_SECONDS,
    questionTimeMs: QUESTION_TIME_MS,

    teamsTaken: Object.keys(state.games).map(Number)
  };
}

// ------------------------------------------------------------
// Direccion IP local y QR
// ------------------------------------------------------------

function lanIPs() {
  const output = [];

  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const address of list || []) {
      if (
        address.family === 'IPv4' &&
        !address.internal
      ) {
        output.push({
          name,
          ip: address.address
        });
      }
    }
  }

  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('172.')) return 1;
    if (ip.startsWith('10.')) return 2;
    return 3;
  };

  return output.sort(
    (a, b) => score(a.ip) - score(b.ip)
  );
}

let joinUrl = '';
let qrSvg = '';

async function refreshUrl() {
  const ips = lanIPs();

  const url =
    process.env.URL ||
    `http://${ips[0] ? ips[0].ip : 'localhost'}:${PORT}`;

  if (url !== joinUrl) {
    joinUrl = url;

    qrSvg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      color: {
        dark: '#0B1F33',
        light: '#FFFFFF'
      }
    });

    broadcast();
  }
}

// ------------------------------------------------------------
// Datos para el dashboard de television
// ------------------------------------------------------------

function tvSummary() {
  const teams = [];

  for (let team = 1; team <= NUM_TEAMS; team++) {
    const game = state.games[team];

    if (!game) {
      teams.push({
        team,
        active: false
      });

      continue;
    }

    const players = game.players.map((player, i) => ({
      name: player.name,
      color: player.color,
      token: player.token,

      money: player.money,
      patrimonio: patrimonio(game, i),

      correct: player.correct,
      wrong: player.wrong,

      projects: Object.values(game.owners).filter(
        (owner) => owner.player === i
      ).length,

      jailed: player.jailed
    }));

    const totalAnswers = players.reduce(
      (sum, player) =>
        sum + player.correct + player.wrong,
      0
    );

    const correctAnswers = players.reduce(
      (sum, player) => sum + player.correct,
      0
    );

    const leader = players.reduce(
      (best, player) =>
        player.patrimonio > best.patrimonio
          ? player
          : best,
      players[0]
    );

    teams.push({
      team,
      active: true,
      players,

      leader: leader.name,
      turnName: game.players[game.turn].name,

      turns: game.turns,
      answers: totalAnswers,

      accuracy: totalAnswers
        ? Math.round(
          (correctAnswers / totalAnswers) * 100
        )
        : null,

      owned: Object.keys(game.owners).length,

      last: game.feed[0]
        ? game.feed[0].text
        : ''
    });
  }

  // Ranking de precisión: mínimo tres respuestas.
  const allPlayers = [];

  teams
    .filter((team) => team.active)
    .forEach((team) => {
      team.players.forEach((player) => {
        allPlayers.push({
          ...player,
          team: team.team,
          total: player.correct + player.wrong
        });
      });
    });

  const topAcc = allPlayers
    .filter((player) => player.total >= 3)
    .map((player) => ({
      ...player,
      acc: Math.round(
        (player.correct / player.total) * 100
      )
    }))
    .sort(
      (a, b) =>
        b.acc - a.acc ||
        b.correct - a.correct
    )
    .slice(0, 5);

  const topRich = allPlayers
    .slice()
    .sort(
      (a, b) => b.patrimonio - a.patrimonio
    )
    .slice(0, 6);

  const questions = {};

  state.log.forEach((entry) => {
    const summary =
      questions[entry.qid] ||
      (questions[entry.qid] = {
        question: entry.question,
        cat: entry.cat,
        wrong: 0,
        total: 0
      });

    summary.total++;

    if (!entry.correct) {
      summary.wrong++;
    }
  });

  const hardest = Object.values(questions)
    .filter((question) => question.wrong > 0)
    .sort(
      (a, b) =>
        b.wrong / b.total - a.wrong / a.total ||
        b.wrong - a.wrong
    )
    .slice(0, 3);

  const totalAnswers = state.log.length;

  const totalCorrect = state.log.filter(
    (entry) => entry.correct
  ).length;

  return {
    ...common(),

    joinUrl,
    qrSvg,

    teams,
    topAcc,
    topRich,
    hardest,

    feed: state.log.slice(-8).reverse(),

    totals: {
      answers: totalAnswers,

      accuracy: totalAnswers
        ? Math.round(
          (totalCorrect / totalAnswers) * 100
        )
        : null
    }
  };
}

// ------------------------------------------------------------
// HTTP y rutas
// ------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const send = (
  res,
  code,
  body,
  type = 'application/json'
) => {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });

  res.end(
    typeof body === 'string' ||
      Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body)
  );
};

const csvCell = (value) =>
  `"${String(value ?? '').replace(/"/g, '""')}"`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  const pin =
    url.searchParams.get('pin') ||
    req.headers['x-pin'];

  // ----------------------------------------------------------
  // Endpoints protegidos del moderador
  // ----------------------------------------------------------

  if (
    url.pathname.startsWith('/api/admin/') ||
    url.pathname === '/export.csv'
  ) {
    if (String(pin) !== ADMIN_PIN) {
      return send(res, 401, {
        error: 'PIN incorrecto'
      });
    }

    // Exportar CSV.
    if (url.pathname === '/export.csv') {
      const rows = [
        [
          'Hora',
          'Equipo',
          'Jugador',
          'Tema',
          'Pregunta',
          'Respondió',
          'Correcta',
          'Acertó',
          'Situación',
          'Usó pista',
          'Tiempo agotado'
        ]
      ].concat(
        state.log.map((entry) => [
          new Date(entry.ts).toLocaleTimeString('es-CO'),
          entry.team,
          entry.player,
          entry.cat,
          entry.question,
          entry.chosen,
          entry.correctText,
          entry.correct ? 'Sí' : 'No',
          entry.reason,
          entry.pista ? 'Sí' : 'No',
          entry.timedOut ? 'Sí' : 'No'
        ])
      );

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition':
          'attachment; filename="respuestas_monopolio_legal.csv"'
      });

      return res.end(
        '\uFEFF' +
        rows
          .map((row) =>
            row.map(csvCell).join(';')
          )
          .join('\n')
      );
    }

    const body =
      req.method === 'POST'
        ? await readBody(req)
        : {};

    const actionName = url.pathname.slice(
      '/api/admin/'.length
    );

    // Consultar trazabilidad.
    if (actionName === 'log') {
      return send(res, 200, {
        log: state.log.slice().reverse(),

        status: state.status,
        endsAt: state.endsAt,
        durationMin: state.durationMin,

        games: Object.values(state.games).map((game) => ({
          team: game.team,

          players: game.players.map((player, i) => ({
            name: player.name,
            money: player.money,
            patrimonio: patrimonio(game, i)
          })),

          turns: game.turns
        }))
      });
    }

    // Iniciar juego.
    if (actionName === 'start') {
      const incompleteGames = Object.values(state.games).filter(
        (game) =>
          game.players.some(
            (player) =>
              !player.tokenChosen ||
              !player.colorChosen
          )
      );

      if (incompleteGames.length > 0) {
        const teams = incompleteGames
          .map((game) => game.team)
          .join(', ');

        return send(res, 400, {
          error:
            `Completa las fichas y colores antes de iniciar. ` +
            `Revisa los equipos: ${teams}.`
        });
      }

      const minutes = Number(body.min);

      state.durationMin = minutes >= 0 ? minutes : 40;
      state.status = 'playing';
      state.startedAt = Date.now();

      state.endsAt = state.durationMin
        ? Date.now() + state.durationMin * 60000
        : null;
    }

    // Pausar juego y conservar el tiempo de cada pregunta.
    else if (actionName === 'pause') {
      if (state.status === 'playing') {
        state.status = 'paused';

        state.pausedLeft = state.endsAt
          ? Math.max(0, state.endsAt - Date.now())
          : null;

        const now = Date.now();

        for (const game of Object.values(state.games)) {
          const pending = game.pending;

          if (
            pending &&
            pending.kind === 'question'
          ) {
            pending.remainingMs =
              Number.isFinite(pending.deadlineAt)
                ? Math.max(
                  0,
                  pending.deadlineAt - now
                )
                : QUESTION_TIME_MS;
          }
        }
      }
    }

    // Reanudar juego y recuperar el tiempo restante.
    else if (actionName === 'resume') {
      if (state.status === 'paused') {
        state.status = 'playing';

        if (
          state.pausedLeft !== null &&
          state.pausedLeft !== undefined &&
          state.endsAt
        ) {
          state.endsAt =
            Date.now() + state.pausedLeft;
        }

        delete state.pausedLeft;

        for (const game of Object.values(state.games)) {
          const pending = game.pending;

          if (
            pending &&
            pending.kind === 'question'
          ) {
            const remaining = Number.isFinite(
              pending.remainingMs
            )
              ? Math.max(0, pending.remainingMs)
              : QUESTION_TIME_MS;

            pending.deadlineAt =
              Date.now() + remaining;

            delete pending.remainingMs;
          }
        }
      }
    }

    // Terminar todas las partidas.
    else if (actionName === 'end') {
      endAll();
    }

    // Añadir cinco minutos.
    else if (actionName === 'addtime') {
      if (state.endsAt) {
        state.endsAt += 5 * 60000;
      }
    }

    // Reiniciar una partida concreta.
    else if (actionName === 'reset-team') {
      const team = Number(body.team);

      delete state.games[team];

      state.log = state.log.filter(
        (entry) => entry.team !== team
      );
    }

    // Saltar turno.
    else if (actionName === 'skip-turn') {
      const game = state.games[Number(body.team)];

      if (game) {
        endTurn(game);
      }
    }

    // Ajustar dinero.
    else if (actionName === 'money') {
      const game = state.games[Number(body.team)];

      const player =
        game &&
        game.players[Number(body.player)];

      if (player) {
        player.money += Number(body.amount) || 0;
      }
    }

    // Reiniciar todo.
    else if (actionName === 'reset-all') {
      state = freshState();
    }

    // Recargar banco de preguntas.
    else if (actionName === 'reload-questions') {
      try {
        QB = loadQuestions();
      } catch (error) {
        return send(res, 400, {
          error:
            'preguntas.json tiene un error: ' +
            error.message
        });
      }
    }

    else {
      return send(res, 404, {
        error: 'Acción desconocida'
      });
    }

    save();
    broadcast();

    return send(res, 200, { ok: true });
  }

  // ----------------------------------------------------------
  // Archivos publicos
  // ----------------------------------------------------------

  const routes = {
    '/': 'index.html',
    '/tv': 'tv.html',
    '/admin': 'admin.html'
  };

  const relativePath =
    routes[url.pathname] ||
    path.normalize(url.pathname).replace(
      /^(\.\.[/\\])+/,
      ''
    );

  const file = path.join(PUBLIC, relativePath);

  if (!file.startsWith(PUBLIC)) {
    return send(res, 403, 'No');
  }

  fs.readFile(file, (error, data) => {
    if (error) {
      return send(
        res,
        404,
        'No encontrado',
        'text/plain'
      );
    }

    send(
      res,
      200,
      data,
      MIME[path.extname(file)] ||
      'application/octet-stream'
    );
  });
});

// ------------------------------------------------------------
// Socket.IO
// ------------------------------------------------------------

const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 20000
});

function emitTeam(team) {
  io.to('team:' + team).emit('state', {
    ...common(),
    game: publicGame(state.games[team])
  });
}

let broadcastTimer = null;

function broadcast() {
  clearTimeout(broadcastTimer);

  broadcastTimer = setTimeout(() => {
    for (let team = 1; team <= NUM_TEAMS; team++) {
      emitTeam(team);
    }

    io.to('lobby').emit('state', {
      ...common(),
      game: null
    });

    io.to('tv').emit('tv', tvSummary());
  }, 60);
}

function endAll() {
  state.status = 'ended';

  Object.values(state.games).forEach((game) => {
    game.phase = 'ended';
    game.pending = null;
  });
}

// ------------------------------------------------------------
// Conexion de clientes
// ------------------------------------------------------------

io.on('connection', (socket) => {
  socket.join('lobby');

  socket.emit('state', {
    ...common(),
    game: null
  });

  socket.on('tv', () => {
    socket.join('tv');
    socket.emit('tv', tvSummary());
  });

  socket.on('join', (data = {}) => {
    const team = Number(data.team);

    if (
      !Number.isInteger(team) ||
      team < 1 ||
      team > NUM_TEAMS
    ) {
      return;
    }

    // Importante:
    // un celular no debe seguir recibiendo los estados del
    // lobby una vez que se incorporó a una partida.
    socket.leave('lobby');

    // Abandonar cualquier sala de equipo anterior.
    for (const room of socket.rooms) {
      if (room.startsWith('team:')) {
        socket.leave(room);
      }
    }

    socket.join('team:' + team);

    socket.data.team = team;

    socket.emit('state', {
      ...common(),
      game: publicGame(state.games[team])
    });
  });

  // Crear partida y registrar participantes.
  socket.on('setup', (data = {}, callback) => {
    const team = Number(data.team);

    if (
      !Number.isInteger(team) ||
      team < 1 ||
      team > NUM_TEAMS
    ) {
      return callback && callback({
        error: 'Equipo inválido'
      });
    }

    if (state.games[team]) {
      return callback && callback({
        error: 'Este equipo ya tiene una partida'
      });
    }

    const names = (data.names || [])
      .map((name) =>
        String(name).trim().slice(0, 18)
      )
      .filter(Boolean);

    if (names.length < 2 || names.length > 4) {
      return callback && callback({
        error: 'Escriban entre 2 y 4 nombres'
      });
    }

    state.games[team] = newGame(team, names);

    if (state.status === 'ended') {
      state.games[team].phase = 'ended';
    }

    feed(
      state.games[team],
      `Partida creada: ${names.join(', ')}`
    );

    // Asegurar que el celular quede en la sala correcta
    // incluso si crea el equipo desde una conexión nueva.
    socket.leave('lobby');

    for (const room of socket.rooms) {
      if (room.startsWith('team:')) {
        socket.leave(room);
      }
    }

    socket.join('team:' + team);
    socket.data.team = team;

    save();
    broadcast();

    callback && callback({ ok: true });
  });

  // Acciones del juego.
  socket.on('action', (data = {}, callback) => {
    const team = Number(data.team);
    const type = data.type;
    const payload = data.payload || {};

    if (
      !Number.isInteger(team) ||
      team < 1 ||
      team > NUM_TEAMS
    ) {
      return callback && callback({
        error: 'Equipo inválido'
      });
    }

    // Las acciones solo pueden modificar el equipo al que
    // está unido el socket, si ya se ha seleccionado uno.
    if (
      socket.data.team &&
      socket.data.team !== team
    ) {
      return callback && callback({
        error: 'Este celular está conectado a otro equipo'
      });
    }

    const error = act(team, type, payload);

    if (error) {
      return callback && callback({ error });
    }

    save();
    broadcast();

    callback && callback({ ok: true });
  });
});

// ------------------------------------------------------------
// Temporizador global de preguntas
//
// El temporizador se controla en el servidor, no solo en el
// navegador. Así, cerrar una pantalla o desconectar el celular
// no evita que expire una pregunta cuando el juego está activo.
// ------------------------------------------------------------

setInterval(() => {
  if (state.status !== 'playing') {
    return;
  }

  let changed = false;

  for (const game of Object.values(state.games)) {
    if (expireQuestion(game)) {
      changed = true;
    }
  }

  if (changed) {
    save();
    broadcast();
  }
}, 250);

// ------------------------------------------------------------
// Temporizador general del juego
// ------------------------------------------------------------

setInterval(() => {
  if (
    state.status === 'playing' &&
    state.endsAt &&
    Date.now() >= state.endsAt
  ) {
    endAll();

    save();
    broadcast();
  }
}, 1000);

// ------------------------------------------------------------
// Actualizar direccion de red para el QR
// ------------------------------------------------------------

setInterval(() => {
  refreshUrl().catch((error) => {
    console.error(
      'No se pudo actualizar el enlace local:',
      error.message
    );
  });
}, 8000);

// ------------------------------------------------------------
// Inicio del servidor
// ------------------------------------------------------------

server.listen(PORT, '0.0.0.0', async () => {
  try {
    await refreshUrl();
  } catch (error) {
    console.error(
      'No se pudo generar el QR:',
      error.message
    );
  }

  const ips = lanIPs();

  console.log('\n  🎲 MONOPOLIO LEGAL listo\n');

  console.log(`  Celulares:   ${joinUrl}`);
  console.log(`  TV:          http://localhost:${PORT}/tv`);
  console.log(
    `  Moderador:   http://localhost:${PORT}/admin   (PIN: ${ADMIN_PIN})`
  );

  if (ips.length > 1) {
    console.log(
      '  Otras IPs de esta máquina: ' +
      ips
        .slice(1)
        .map((address) => `${address.ip} (${address.name})`)
        .join(', ')
    );
  }

  if (!ips.length) {
    console.log(
      '  ⚠️ No hay red: conecta la máquina al hotspot.'
    );
  }

  console.log('');
});

// ------------------------------------------------------------
// Exportaciones opcionales para pruebas
// ------------------------------------------------------------

module.exports = {
  act,
  state: () => state
};