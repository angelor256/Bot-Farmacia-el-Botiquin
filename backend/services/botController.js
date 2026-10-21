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
const log = require('../utils/logger');
const { mask } = require('../utils/phone');

/* ---------- Textos del flujo ---------- */
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

/* ---------- FSM por telefono ---------- */
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
  return 'Disculpe, no entendi 😅. Por favor digite el número de la opcion correspondiente:\n\n' + MENU;
}

function handleBranchChoice(phone, msg) {
  if (msg === '1' || msg === '2') {
    const branch = BRANCH_NAMES[msg];
    store.setFsmState(phone, { state: 3, branch });
    return '¡Perfecto! 😊 Sera un gusto atenderle desde nuestra Sucursal ' + branch + '. 💙\n\nCuenteme, ¿en que le puedo ayudar?';
  }
  return 'Por favor digite 1️⃣ Pavas Centro o 2️⃣ Lomas del Rio para continuar con su pedido. 💊';
}

/** Estado 3: llama a la IA con historial del usuario y fallback garantizado. */
async function handleAiStage(phone, msg) {
  const u = store.ensureShape(phone);
  const history = store.getRecentHistory(phone); // OBJETIVO #2: contexto filtrado por numero
  const context = { ...businessConfig, branch: u.fsm.branch, option: u.fsm.option };
  const result = await ai.generateReply({ userMessage: msg, history, context });
  log.info('[ai] ' + mask(phone) + ' -> ' + result.provider + '/' + result.model + (result.degraded ? ' (degradado)' : ''));
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
      if (fsm.state <= 1) reply = handleOptionChoice(phone, text);
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

module.exports = { processIncoming, setBusinessConfig, getBusinessConfig, MENU, MSG_WELCOME, MSG_BRANCHES, queues };
