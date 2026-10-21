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
const log = require('../utils/logger');
const { mask } = require('../utils/phone');

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
function handleOptionChoice(phone, msg) {
  if (msg === '1' || msg === '2') {
    store.setFsmState(phone, { state: 2, option: OPTION_NAMES[msg] });
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
    store.setFsmState(phone, { state: 2, option: OPTION_NAMES[1] });
    return '📍 *Nuestras sucursales*\n\n🏥 Pavas Centro - Frente a la feria del farmer, L-20\n🏥 Lomas del Rio - 100 m sur de la entrada principal\n\n🕐 Lun-Sab 7:00-22:00 · Dom 8:00-20:00\n\nDigite 1 o 2 para hacer un pedido en una de ellas. 💊';
  }
  // Mensaje libre en estado de menú: antes solo decía "no entendí" y el usuario
  // se bucleaba. Ahora intenta responder con la base de conocimiento enseñada
  // desde el panel; si no sabe, suma el contador de malentendidos que dispara
  // el traspaso a humano (regla del mapa de interacción).
  const free = kb.retrieve(msg, { topK: 1 })[0];
  if (free && free.score >= 3) return '💙 Sobre su consulta:\n\n' + free.excerpt + '\n\n¿Desea continuar con un pedido? Digite el número de la opción:\n\n' + MENU;
  store.bumpMisroutes(phone);
  return 'Disculpe, no entendi 😅. Por favor digite el número de la opcion correspondiente:\n\n' + MENU;
}

function handleBranchChoice(phone, msg) {
  if (msg === '1' || msg === '2') {
    const branch = BRANCH_NAMES[msg];
    store.setFsmState(phone, { state: 3, branch });
    return '¡Perfecto! 😊 Sera un gusto atenderle desde nuestra Sucursal ' + branch + '. 💙\n\nCuenteme, ¿en que le puedo ayudar?';
  }
  store.bumpMisroutes(phone);
  return 'Por favor digite 1️⃣ Pavas Centro o 2️⃣ Lomas del Rio para continuar con su pedido. 💊';
}

/** Estado 3: llama a la IA con historial del usuario y fallback garantizado. */
async function handleAiStage(phone, msg) {
  const u = store.ensureShape(phone);
  const history = store.getRecentHistory(phone); // OBJETIVO #2: contexto filtrado por numero
  const context = { ...businessConfig, branch: u.fsm.branch, option: u.fsm.option };
  const result = await ai.generateReply({ userMessage: msg, history, context });
  log.info('[ai] ' + mask(phone) + ' -> ' + result.provider + '/' + result.model + (result.degraded ? ' (degradado)' : ''));
  // Protocolo de traspaso estilo Fin: la IA añade un token INVISIBLE cuando una
  // política exige escalar; lo retiramos del texto y pausamos el bot para ESTE usuario.
  if (/\[\[ESCALAR_HUMANO\]\]/.test(result.text)) {
    store.pauseBot(phone, { pausedBy: 'ia-politica', reason: 'token-de-escalado' });
    store.setFsmState(phone, { state: 4 });
    log.info('[bot] IA solicito escalado segun politica -> bot pausado para ' + mask(phone));
    return result.text.replace(/\s*\[\[ESCALAR_HUMANO\]\]\s*/g, '').trim();
  }
  return result.text;
}

/**
 * Punto de entrada unico desde el webhook / simulador del panel.
 * @returns {Promise<{handled:boolean, reason?:string, reply?:string}>}
 */
function processIncoming({ from, text, name }) {
  const phone = String(from || '').trim();
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
    let reply;
    try {
      // Reglas de escalado ANTES de gastar tokens de IA (deterministas y gratis).
      // Los números del menú quedan excluidos: el flujo FSM tiene prioridad.
      const trig = kb.detectEscalation(text, { policies: kb.getKnowledge().policies, fsm });
      if (trig) {
        store.pauseBot(phone, { pausedBy: 'auto-' + trig.reason, reason: trig.policy });
        store.setFsmState(phone, { state: 4 });
        log.info('[bot] escalado automático (' + trig.reason + ') para ' + mask(phone));
        reply = MSG_HUMAN_TAKEOVER;
      } else if (fsm.state <= 1) reply = handleOptionChoice(phone, text);
      else if (fsm.state === 2) reply = handleBranchChoice(phone, text);
      else reply = await handleAiStage(phone, text);
    } catch (err) {
      log.error('[bot] error inesperado en el flujo:', err);
      reply = ai.defaultFallback(); // NUNCA dejar al cliente colgado
    }
    await replyTo(phone, reply);
    return { handled: true, reply };
  });
}

module.exports = { processIncoming, setBusinessConfig, getBusinessConfig, MENU, MSG_WELCOME, MSG_BRANCHES, MSG_HUMAN_TAKEOVER, queues };
