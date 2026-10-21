'use strict';
/**
 * services/store.js — Capa de persistencia tipo repositorio.
 *
 * Almacena en memoria (Map) + snapshot atómico en disco, con clave = teléfono
 * NORMALIZADO. En producción basta sustituir readSnapshot/writeSnapshot por
 * Redis o Postgres sin tocar el resto de la aplicación (interface estable).
 *
 * Estructura por usuario:
 *   { phone, name, botPaused:{pausedBy,reason,pausedAt}, fsm:{state,option,branch},
 *     history:[{role:'user'|'model', text, ts}], updatedAt }
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const phoneUtil = require('../utils/phone');
const log = require('../utils/logger');

const FILE = path.join(config.dataDir, 'chats.json');
const MAX_MSG_CHARS = 1200;
const users = new Map();


/* Clave de usuario: número normalizado O id de sesión alfanumérico (simulador del panel). */
function userKey(rawPhone) {
  const n = phoneUtil.normalize(rawPhone);
  if (n) return n;
  const s = String(rawPhone ?? '').trim();
  return /^[\w.\-]{2,32}$/.test(s) ? s : '';
}

function ensureShape(p) {
  const key = userKey(p);

  if (!key) throw new Error('store: teléfono vacío/no válido');
  if (!users.has(key)) {
    users.set(key, { phone: key, name: null, botPaused: null, fsm: { state: 0, option: null, branch: null }, history: [], updatedAt: null });
  }
  return users.get(key);
}

/* ---------------- Historial (objetivo #2) ---------------- */

/** Añade un mensaje al historial del usuario y devuelve la ventana reciente. */
function appendMessage(rawPhone, role, text, meta = {}) {
  const u = ensureShape(rawPhone);
  const msg = { role, text: String(text || '').slice(0, MAX_MSG_CHARS), ts: Date.now(), ...meta };
  u.history.push(msg);
  // Poda defensiva: nunca más de 50 mensajes crudos por usuario en memoria.
  if (u.history.length > 50) u.history = u.history.slice(-50);
  u.updatedAt = msg.ts;
  schedulePersist();
  return msg;
}

/**
 * Historial RECIENTE filtrado por número telefónico, listo para la IA.
 * @param {string} rawPhone  Número del cliente (cualquier formato).
 * @param {number} limit     Nº máximo de mensajes (por defecto config.ai.historyWindow).
 * @returns {{role:string, text:string}[]} ordenado de antiguo a nuevo.
 */
function getRecentHistory(rawPhone, limit = config.ai.historyWindow) {
  const u = users.get(userKey(rawPhone));
  if (!u) return [];
  return u.history.slice(-Math.max(1, limit)).map(({ role, text }) => ({ role, text }));
}

/** Conversación completa para la vista del agente humano en el panel. */
function getConversation(rawPhone) {
  const u = users.get(userKey(rawPhone));
  if (!u) return null;
  return { phone: u.phone, name: u.name, botPaused: !!u.botPaused, fsm: u.fsm, messages: u.history.slice() };
}

/** Lista de contactos ordenados por última actividad (bandeja del panel). */
function listContacts({ limit = 50 } = {}) {
  return [...users.values()]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit)
    .map((u) => ({
      phone: u.phone,
      name: u.name,
      lastMessage: u.history.length ? u.history[u.history.length - 1].text : '',
      lastAt: u.updatedAt,
      botPaused: !!u.botPaused,
      pausedBy: u.botPaused ? u.botPaused.pausedBy : null,
      fsmState: u.fsm.state,
    }));
}

/* ---------------- Control Agente Humano vs Bot (objetivo #3) ---------------- */

/** Pausa el bot para UN usuario concreto (no global): lo toma un humano. */
function pauseBot(rawPhone, { pausedBy = 'agente', reason = '' } = {}) {
  const u = ensureShape(rawPhone);
  u.botPaused = { pausedBy, reason, pausedAt: Date.now() };
  schedulePersist();
  log.info(`[pause] bot pausado para ${phoneUtil.mask(u.phone)} por ${pausedBy}`);
  return u.botPaused;
}

/** Reactiva el bot para ese usuario. */
function resumeBot(rawPhone) {
  const u = ensureShape(rawPhone);
  u.botPaused = null;
  schedulePersist();
  log.info(`[resume] bot reactivado para ${phoneUtil.mask(u.phone)}`);
  return true;
}

/** ¿Debe contestar el bot? (check barato en el hot-path del webhook) */
function isBotEnabled(rawPhone) {
  const u = users.get(userKey(rawPhone));
  return !(u && u.botPaused);
}

/* ---------------- Máquina de estados del flujo ---------------- */

function setFsmState(rawPhone, patch) {
  const u = ensureShape(rawPhone);
  u.fsm = { ...u.fsm, ...patch };
  schedulePersist();
  return u.fsm;
}

/** Contador de malentendidos (mensajes que el FSM no supo enrutar). */
function bumpMisroutes(rawPhone) {
  const u = ensureShape(rawPhone);
  u.fsm.misroutes = (u.fsm.misroutes || 0) + 1;
  schedulePersist();
  return u.fsm.misroutes;
}

/** Reinicia el flujo de un usuario (botón "Reiniciar chat" del panel). */
function resetUser(rawPhone) {
  const key = phoneUtil.normalize(rawPhone);
  const u = users.get(key);
  if (!u) return false;
  u.fsm = { state: 0, option: null, branch: null, misroutes: 0 };
  u.history = [];
  u.botPaused = null;
  schedulePersist();
  log.info(`[reset] flujo reiniciado para ${phoneUtil.mask(key)}`);
  return true;
}

/* ---------------- Persistencia en disco (debounced, atómica) ---------------- */

let persistTimer = null;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writeSnapshot, 400);
  if (persistTimer.unref) persistTimer.unref();
}

function writeSnapshot() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(users), null, 2));
    fs.renameSync(tmp, FILE); // rename = escritura atómica
  } catch (err) {
    log.warn('[store] no se pudo persistir en disco:', err.message);
  }
}

function loadSnapshot() {
  try {
    if (!fs.existsSync(FILE)) return;
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) users.set(k, v);
    log.info(`[store] ${users.size} conversaciones restauradas desde disco`);
  } catch (err) {
    log.warn('[store] snapshot ilegible, se inicia vacío:', err.message);
  }
}

loadSnapshot();

module.exports = {
  appendMessage, getRecentHistory, getConversation, listContacts,
  pauseBot, resumeBot, isBotEnabled, setFsmState, ensureShape, bumpMisroutes, resetUser,
  __test: { users, writeSnapshot },
};
