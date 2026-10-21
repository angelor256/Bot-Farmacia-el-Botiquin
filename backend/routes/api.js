'use strict';
/**
 * routes/api.js — API REST del panel web (config, historial, pausa del bot).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const store = require('../services/store');
const bot = require('../services/botController');
const ai = require('../services/aiService');
const wa = require('../services/whatsappService');
const kb = require('../services/knowledgeService');
const { normalize } = require('../utils/phone');
const log = require('../utils/logger');

const router = express.Router();

/* Autenticacion de las rutas administrativas via cabecera X-Admin-Token. */
function requireAdmin(req, res, next) {
  if (!config.admin.token) return next(); // sin token configurado (dev) = abierto
  if (req.get('x-admin-token') === config.admin.token) return next();
  return res.status(401).json({ error: 'No autorizado: falta o es invalido el header X-Admin-Token' });
}

/* Limite de peticiones al backend de IA desde el navegador. */
const chatLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

router.use(express.json({ limit: '2mb' }));

/* Publico: estado de salud (no revela claves). */
router.get('/health', (_req, res) => {
  res.json({ ok: true, env: config.env, ai: ai.health(), whatsappConfigured: !!(config.whatsapp.accessToken && config.whatsapp.phoneNumberId) });
});

/* Config actual del bot (lectura para pintar el panel). */
router.get('/config', requireAdmin, (_req, res) => res.json(bot.getBusinessConfig()));

/* Seccion C del panel: publicar reglas + listas. */
router.post('/config', requireAdmin, (req, res) => {
  const { business_rules, price_lists, bot_name, pharmacy } = req.body || {};
  if (business_rules && typeof business_rules !== 'object') return res.status(400).json({ error: 'business_rules debe ser un objeto' });
  const saved = bot.setBusinessConfig({ business_rules, price_lists, bot_name, pharmacy, saved_at: new Date().toISOString() });
  log.info('[api] configuracion publicada:', Object.keys(saved.business_rules || {}));
  res.json({ ok: true, config: saved });
});

/* Bandeja de conversaciones para el agente humano. */
router.get('/conversations', requireAdmin, (req, res) => {
  res.json({ contacts: store.listContacts({ limit: parseInt(req.query.limit, 10) || 50 }) });
});

/* Historial reciente filtrado por numero telefonico (objetivo #2). */
router.get('/conversations/:phone', requireAdmin, (req, res) => {
  const conv = store.getConversation(req.params.phone);
  if (!conv) return res.status(404).json({ error: 'No existe conversacion para ese numero' });
  res.json(conv);
});

/* OBJETIVO #3: tomar el chat (pausar el bot) / devolverlo al bot. */
router.post('/conversations/:phone/pause', requireAdmin, (req, res) => {
  const phone = normalize(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Numero de telefono invalido' });
  res.json({ ok: true, botPaused: store.pauseBot(phone, { pausedBy: req.body?.pausedBy || 'agente', reason: req.body?.reason || '' }) });
});

router.post('/conversations/:phone/resume', requireAdmin, (req, res) => {
  const phone = normalize(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Numero de telefono invalido' });
  res.json({ ok: true, botPaused: false });
  store.resumeBot(phone);
});

/* El agente humano responde por WhatsApp desde el panel. */
router.post('/conversations/:phone/reply', requireAdmin, async (req, res) => {
  const phone = normalize(req.params.phone);
  const text = String(req.body?.text || '').trim();
  if (!phone || !text) return res.status(400).json({ error: 'Faltan "phone" o "text"' });
  store.appendMessage(phone, 'model', text, { via: 'human' });
  const r = await wa.sendText(phone, text);
  res.status(r.ok ? 200 : 502).json(r);
});

/* Simulador del panel: mismo flujo que el webhook, pero local y con respuesta. */
router.post('/chat/simulate', chatLimiter, requireAdmin, async (req, res) => {
  const from = normalize(req.body?.phone || 'sim-local');
  const text = String(req.body?.message || '').trim();
  if (!text) return res.status(400).json({ error: 'El mensaje esta vacio' });
  const result = await bot.processIncoming({ from, text });
  const conv = store.getConversation(from);
  res.json({ ...result, state: conv?.fsm?.state ?? null, history: store.getRecentHistory(from), conversation: conv });
});

/* ============================================================
   SECCIÓN D · ENTRENA AL BOT — Base de conocimiento estilo Fin AI
   ============================================================ */

/* Ver qué sabe hoy el bot: artículos + políticas + mapa de interacción. */
router.get('/knowledge', requireAdmin, (_req, res) => {
  const k = kb.getKnowledge();
  res.json({ ...k, counts: { articles: k.articles.length, policies: k.policies.length } });
});

/* Enseñar/actualizar por secciones: solo se reemplaza lo que llega en el body. */
router.put('/knowledge', requireAdmin, (req, res) => {
  try {
    const saved = kb.setKnowledge(req.body || {});
    log.info('[api] base de conocimiento publicada desde el panel');
    res.json({ ok: true, knowledge: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* Prueba "lo que la IA vería": system prompt con RAG + política detectada. */
router.post('/knowledge/test', requireAdmin, (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Falta "message"' });
  const { buildSystemPrompt } = require('../services/promptBuilder');
  const prompt = buildSystemPrompt({ ...bot.getBusinessConfig(), message });
  res.json({
    retrieved: kb.retrieve(message, { topK: 3 }),
    escalationTrigger: kb.detectEscalation(message, { policies: kb.getKnowledge().policies }),
    promptPreview: prompt.slice(0, 2600),
    promptChars: prompt.length,
  });
});

/* Reiniciar el flujo de un usuario concreto (deja de estar pausado también). */
router.post('/conversations/:phone/reset', requireAdmin, (req, res) => {
  const phone = normalize(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Numero de telefono invalido' });
  res.json({ ok: store.resetUser(phone), phone });
});

module.exports = router;
