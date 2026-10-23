'use strict';
/**
 * services/botController.js — Orquestador del flujo (FSM) + decisiones de IA.
 *
 * Este es el "cerebro" que antes estaba mezclado dentro del HTML:
 *   - decide si responde el BOT o un HUMANO (objetivo #3),
 *   - mantiene el estado por numero telefonico,
 *   - inyecta el historial reciente al llamar a la IA (objetivo #2),
 *   - nunca deja al cliente sin respuesta: fallback garantizado (objetivo #1).
 */
const store = require('./store');
const ai = require('./aiService');
const wa = require('./whatsappService');
const kb = require('./knowledgeService');
const training = require('./trainingService');
const log = require('../utils/logger');
const { mask, normalize } = require('../utils/phone');

/* IDs de sesión no telefónicos (simulador del panel: "sim-panel"): se conservan tal cual. */
function resolveKey(raw) {
  const n = normalize(raw);
  if (n) return n;
  const s = String(raw || '').trim();
  return /^[\w.\-]{2,32}$/.test(s) ? s : '';
}

/* ---------- Textos del flujo ---------- */
const MSG_HUMAN_TAKEOVER = 'Perfecto, le paso con un asesor humano 💙. En breve le atenderá una persona por este medio.';
const MENU = '1️⃣ Compra de productos\n2️⃣ Consulta Farmacéutica\n3️⃣ Macrobiótica y Suplementos\n4️⃣ Sugerencias y mejoras de servicio\n5️⃣ Horarios y direcciones de nuestras sucursales';
const MSG_WELCOME = '😊 Soy Dr. Boti, asistente virtual de Farmacia El Botiquín. 💙🧡\n\nPara ayudarle con lo que necesita, por favor digite el número de la opción correspondiente:\n\n' + MENU + '\n\nSerá un gusto ayudarle.';
const MSG_BRANCHES = '¡Con mucho gusto! 😊💙\n\n¿En cuál de nuestras sucursales desea realizar su pedido?\n\n1️⃣ Pavas Centro\n2️⃣ Lomas del Río\n\nPor favor, digite 1 o 2 para continuar con su pedido. 💊';
const BRANCH_NAMES = { 1: 'Pavas Centro', 2: 'Lomas del Río' };
const OPTION_NAMES = { 1: 'Compra de productos', 2: 'Consulta Farmacéutica', 3: 'Macrobiótica y Suplementos' };
const GREETING_RE = /^(hola|holi|buenas|buen[oa]s?\s*(d[ií]as|tardes|noches)|hey|hi|saludos?)\b/i;
const THANKS_RE = /\b(gracias|muchas\s*gracias)\b/i;

/* ---------- Configuracion de negocio publicada desde el panel ---------- */
let businessConfig = {
  bot_name: 'Dr. Boti',
  pharmacy: 'Farmacia El Botiquin',
  business_rules: { envios_domicilio: true, ofrecer_genericos: true, recetas_medicas: false, macrobiotica: false, fuera_de_linea: false },
  price_lists: [],
};

function setBusinessConfig(patch) {
  businessConfig = { ...businessConfig, ...patch, business_rules: { ...businessConfig.business_rules, ...(patch.business_rules || {}) } };
  return businessConfig;
}
const getBusinessConfig = () => businessConfig;

/* Cola serial por usuario: evita respuestas entrelazadas / condiciones de carrera. */
const queues = new Map();
function enqueue(phone, task) {
  const prev = queues.get(phone) || Promise.resolve();
  const next = prev.then(task).catch((e) => log.error('[bot] tarea fallo:', e));
  queues.set(phone, next);
  next.finally(() => { if (queues.get(phone) === next) queues.delete(phone); });
  return next;
}

async function replyTo(phone, text) {
  store.appendMessage(phone, 'model', text, { via: 'bot' });
  await wa.sendText(phone, text);
}

/* ---------- FSM por telefono (los números del menú SIEMPRE tienen prioridad) ---------- */
function handleOptionChoice(phone, msg, meta = {}) {
  if (msg === '1' || msg === '2') {
    store.setFsmState(phone, { state: 2, option: OPTION_NAMES[msg], misroutes: 0 });
    return MSG_BRANCHES;
  }
  if (GREETING_RE.test(msg)) return '¡Hola! 👋😊 Qué gusto saludarle. 💙🧡\n\nPara ayudarle, digite el número de la opción:\n\n' + MENU;
  if (THANKS_RE.test(msg)) return '¡Con mucho placer! Es un gusto servirle. Que tenga excelente dia. 😊💙🧡';
  if (msg === '3') {
    const on = businessConfig.business_rules.macrobiotica;
    return '¡Excelente elección! 🌿\n\nLa opcion «Macrobiotica y Suplementos» esta ' + (on ? 'disponible en nuestro catalogo' : 'temporalmente deshabilitada por el administrador') + '.\n\n' + (on ? 'Cuenteme, ¿que suplemento o producto natural busca? 😊' : 'Puede elegir otra opcion del menu. 💙');
  }
  if (msg === '4') return 'Muchas gracias por ayudarnos a mejorar 🙏\n\nEscriba su sugerencia y el equipo de El Botiquin la revisara personalmente. 💙';
  if (msg === '5') {
    store.setFsmState(phone, { state: 2, option: OPTION_NAMES[1], misroutes: 0 });
    return '📍 *Nuestras sucursales*\n\n🏥 Pavas Centro - Frente a la feria del farmer, L-20\n🏥 Lomas del Rio - 100 m sur de la entrada principal\n\n🕐 Lun-Sab 7:00-22:00 · Dom 8:00-20:00\n\nDigite 1 o 2 para hacer un pedido en una de ellas. 💊';
  }
  // Mensaje libre en estado de menú: antes solo decía "no entendí" y el usuario
  // se bucleaba. Ahora intenta responder con la base de conocimiento enseñada
  // desde el panel; si no sabe, suma el contador de malentendidos que dispara
  // el traspaso a humano (regla del mapa de interacción).
  const free = kb.retrieve(msg, { topK: 1 })[0];
  if (free && free.score >= 3) return '💙 Sobre su consulta:\n\n' + free.excerpt + '\n\n¿Desea continuar con un pedido? Digite el número de la opción:\n\n' + MENU;
  store.bumpMisroutes(phone);
  if (msg.length >= 8) training.noteGap({ question: msg, reason: 'menu-no-entendido', intent: meta.intent });
  return 'Disculpe, no entendi 😅. Por favor digite el número de la opcion correspondiente:\n\n' + MENU;
}

function handleBranchChoice(phone, msg, meta = {}) {
  if (msg === '1' || msg === '2') {
    const branch = BRANCH_NAMES[msg];
    store.setFsmState(phone, { state: 3, branch, misroutes: 0 });
    return '¡Perfecto! 😊 Sera un gusto atenderle desde nuestra Sucursal ' + branch + '. 💙\n\nCuenteme, ¿en que le puedo ayudar?';
  }
  store.bumpMisroutes(phone);
  if (msg.length >= 8) training.noteGap({ question: msg, reason: 'sucursal-no-entendido', intent: meta.intent });
  return 'Por favor digite 1️⃣ Pavas Centro o 2️⃣ Lomas del Rio para continuar con su pedido. 💊';
}

/** Estado 3: llama a la IA con historial del usuario y fallback garantizado. */
async function handleAiStage(phone, msg, meta = {}) {
  const u = store.ensureShape(phone);
  // Bug "no responde correctamente" (ramo de menú): si el cliente escribe texto
  // libre en estado 2, antes se re-pregaba por la sucursal INDEFINIDAMENTE y el
  // chat quedaba atrapado ahí (nunca llegaba a la IA). A las 2 insistencias sin
  // un 1/2 válido, asumimos que ya no está pidiendo producto y avanzamos al
  // estado de IA usando la última sucursal conocida (o la principal).
  if ((u.fsm.misroutes || 0) >= 2) {
    store.setFsmState(phone, { state: 3, branch: u.fsm.branch || BRANCH_NAMES[1] });
    log.info('[bot] ' + mask(phone) + ': 2 intentos sin opción válida -> se cede a la IA en modo libre.');
    // No hay return: continuamos y esta misma respuesta la atiende la IA/RAG.
  }
  const history = store.getRecentHistory(phone); // OBJETIVO #2: contexto filtrado por numero
  const context = { ...businessConfig, branch: u.fsm.branch, option: u.fsm.option };
  const result = await ai.generateReply({ userMessage: msg, history, context });
  log.info('[ai] ' + mask(phone) + ' -> ' + result.provider + '/' + result.model + (result.degraded ? ' (degradado)' : ''));
  // El destino libre ya no es un laberinto: si la IA respondió, reseteamos el
  // contador para que una futura mala lectura no escale de forma encadenada.
  store.setFsmState(phone, { misroutes: 0 });
  const hits = kb.retrieve(msg, { topK: 3 });
  kb.markUsed(hits.map((h) => h.id));
  meta.sources = hits.map((h) => h.title);
  meta.provider = result.provider;
  meta.outcome = 'ia';
  if (result.provider === 'fallback-local' && result.model === 'none') {
    // Ni la IA ni la base local supieron responder: queda como recomendación para enseñarle al bot.
    meta.outcome = 'fallback';
    training.noteGap({ question: msg, reason: 'ia-sin-respuesta', intent: meta.intent });
  }
  // Protocolo de traspaso estilo Fin: la IA añade un token INVISIBLE cuando una
  // política exige escalar; lo retiramos del texto y pausamos el bot para ESTE usuario.
  if (/\[\[ESCALAR_HUMANO\]\]/.test(result.text)) {
    store.pauseBot(phone, { pausedBy: 'ia-politica', reason: 'token-de-escalado' });
    store.setFsmState(phone, { state: 4, proc: null });
    meta.outcome = 'escalado';
    log.info('[bot] IA solicito escalado segun politica -> bot pausado para ' + mask(phone));
    return result.text.replace(/\s*\[\[ESCALAR_HUMANO\]\]\s*/g, '').trim();
  }
  // Si la IA remota estaba caída y ni siquiera las reglas locales cubrieron la
  // pregunta, avisamos honestamente y ofrecemos la opción humana en vez de
  // dejar al cliente dando vueltas sobre un menú que no pidió.
  return result.text;
}

/** Traspaso a humano: pausa el bot para ESTE número y cancela cualquier procedimiento en curso. */
function escalate(phone, by, reason) {
  store.pauseBot(phone, { pausedBy: by, reason });
  store.setFsmState(phone, { state: 4, proc: null });
}

/** Aplica el resultado de un paso de procedimiento (continúa, termina o traspasa) y devuelve el texto. */
function applyProcStep(phone, proc, r, meta) {
  if (!r.done) {
    store.setFsmState(phone, { proc: { id: proc.id, i: r.i, data: r.data } });
    meta.outcome = 'procedimiento';
  } else if (r.done === 'handoff') {
    store.pauseBot(phone, { pausedBy: 'procedimiento', reason: proc.name });
    store.setFsmState(phone, { state: 4, proc: null, summary: { procedure: proc.name, data: r.data, at: Date.now() } });
    training.procStat(proc.id, 'handoffs');
    meta.outcome = 'procedimiento-traspaso';
  } else {
    store.setFsmState(phone, { proc: null });
    training.procStat(proc.id, 'completed');
    meta.outcome = 'procedimiento-fin';
  }
  return r.out.join('\n\n');
}

/** Procedimientos: continúa el que está en curso o arranca uno cuyo disparador coincide. null = no aplica. */
function handleProcedure(phone, text, meta, isMenuNumber) {
  const fsm = store.ensureShape(phone).fsm;
  if (fsm.proc) {
    const proc = training.getProcedure(fsm.proc.id);
    if (!proc || proc.state !== 'live') { store.setFsmState(phone, { proc: null }); return null; } // despublicado a mitad de camino
    if (/^(cancelar|cancela|salir)$/i.test(text.trim())) {
      store.setFsmState(phone, { proc: null });
      meta.outcome = 'procedimiento';
      return 'Listo, cancelé el proceso. ¿En qué más le puedo ayudar? 💙';
    }
    return applyProcStep(phone, proc, training.continueProcedure(proc, fsm.proc, text), meta);
  }
  if (fsm.state >= 3 && !isMenuNumber) {
    const proc = training.findProcedure(text, meta.intent);
    if (proc) {
      training.procStat(proc.id, 'started');
      return applyProcStep(phone, proc, training.startProcedure(proc), meta);
    }
  }
  return null;
}

/**
 * Punto de entrada unico desde el webhook / simulador del panel.
 * @returns {Promise<{handled:boolean, reason?:string, reply?:string}>}
 */
function processIncoming({ from, text, name }) {
  const phone = resolveKey(from); // números reales O ids de sesión del simulador ("sim-panel")
  if (!phone || !text) return Promise.resolve({ handled: false, reason: 'empty-payload' });

  // OBJETIVO #3: si un agente humano tomo este chat, el bot NO responde.
  if (!store.isBotEnabled(phone)) {
    store.appendMessage(phone, 'user', text, { via: 'client' });
    if (name) store.ensureShape(phone).name = name;
    log.info('[bot] pausado por humano -> mensaje de ' + mask(phone) + ' guardado para el agente, sin respuesta automatica.');
    return Promise.resolve({ handled: false, reason: 'bot-paused-by-human' });
  }

  return enqueue(phone, async () => {
    store.appendMessage(phone, 'user', text, { via: 'client' });
    if (name && !store.ensureShape(phone).name) store.ensureShape(phone).name = name;

    const fsm = store.ensureShape(phone).fsm;
    const isMenuNumber = /^\d{1,2}$/.test(text.trim());
    const meta = { outcome: 'menu', intent: training.classifyIntent(text), sources: [], provider: null };
    store.setFsmState(phone, { lastIntent: meta.intent });
    let reply;
    try {
      // Orden de decisión (de lo determinista a lo interpretado), como Fin:
      // Safety Guard → reglas de escalado → políticas → procedimiento → menú / IA.
      const safety = training.checkSafety(text);
      const rule = !safety && !isMenuNumber ? training.evaluateRules(text, { intent: meta.intent, misroutes: fsm.misroutes }) : null;
      // Los números del menú quedan excluidos del escalado: el flujo FSM tiene prioridad.
      const trig = !safety && !rule ? kb.detectEscalation(text, { policies: kb.getKnowledge().policies, fsm }) : null;
      if (safety) {
        escalate(phone, 'seguridad-' + safety.id, 'Safety Guard');
        meta.outcome = 'seguridad';
        log.info('[bot] Safety Guard (' + safety.id + ') para ' + mask(phone));
        reply = safety.message;
      } else if (rule) {
        escalate(phone, 'regla-' + rule.reason, rule.policy);
        meta.outcome = 'escalado';
        log.info('[bot] regla de escalado "' + rule.policy + '" para ' + mask(phone));
        reply = rule.message || MSG_HUMAN_TAKEOVER;
      } else if (trig) {
        escalate(phone, 'auto-' + trig.reason, trig.policy);
        meta.outcome = 'escalado';
        log.info('[bot] escalado automático (' + trig.reason + ') para ' + mask(phone));
        reply = MSG_HUMAN_TAKEOVER;
      } else {
        const procReply = handleProcedure(phone, text, meta, isMenuNumber);
        if (procReply !== null) reply = procReply;
        else if (fsm.state <= 1) reply = handleOptionChoice(phone, text, meta);
        else if (fsm.state === 2) reply = handleBranchChoice(phone, text, meta);
        else reply = await handleAiStage(phone, text, meta);
      }
    } catch (err) {
      log.error('[bot] error inesperado en el flujo:', err);
      meta.outcome = 'fallback';
      reply = ai.defaultFallback(); // NUNCA dejar al cliente colgado
    }
    await replyTo(phone, reply);
    training.recordEvent({ phone: mask(phone), intent: meta.intent, outcome: meta.outcome, provider: meta.provider, sources: meta.sources, question: text.slice(0, 200) });
    return { handled: true, reply, outcome: meta.outcome, intent: meta.intent };
  });
}

module.exports = { processIncoming, setBusinessConfig, getBusinessConfig, MENU, MSG_WELCOME, MSG_BRANCHES, MSG_HUMAN_TAKEOVER, queues };
