'use strict';
/**
 * services/whatsappService.js — ÚNICO punto que habla con WhatsApp.
 *
 * Responsabilidad: normalizar el payload del webhook de Meta Cloud API y
 * enviar mensajes de salida. NO contiene lógica de IA ni de negocio
 * (eso vive en aiService / botController), para poder cambiar de proveedor
 * (Meta Cloud API ↔ Twilio ↔ 360dialog) tocando solo este archivo.
 */
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const log = require('../utils/logger');
const { normalize, mask } = require('../utils/phone');

/**
 * Verificación del webhook (GET): Meta manda hub.challenge si los tokens coinciden.
 */
function verifyWebhook({ mode, token, challenge }) {
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken && config.whatsapp.verifyToken) {
    return challenge;
  }
  return null;
}

/**
 * Firma X-Hub-Signature-256 → true si el POST viene realmente de Meta.
 * Requiere el raw body (express.raw) por eso el route usa verify de express.
 */
function isValidSignature(rawBody, signatureHeader) {
  if (!config.whatsapp.appSecret) return true; // sin secreto configurado = validación desactivada (dev)
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const got = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(got, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Extrae los mensajes entrantes útiles del payload (que suele venir anidado
 * entry[].changes[].value.messages[] y trae también status/echos que hay que ignorar).
 * @returns {{from:string, text:string, id:string, type:string, name?:string}[]}
 */
function parseIncoming(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // 1) Ignora eventos de estado (delivered/read) y ecos de lo enviado por el panel.
      if (value.statuses && !value.messages) continue;
      for (const m of value.messages || []) {
        // Los mensajes reenviados/from me no se procesan para evitar bucles bot-bot.
        if (m.from === undefined) continue;
        const from = normalize(m.from);
        if (!from) continue;
        const text =
          m.text?.body ??
          m.button?.text ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          (m.image ? '[📷 imagen recibida]' : m.document ? `[📄 ${m.document.filename || 'documento'}]` : m.audio ? '[🎤 audio]' : '') ?? '';
        if (!String(text).trim()) continue;
        out.push({ id: m.id, from, text: String(text).trim(), type: m.type || 'text', name: value.contacts?.[0]?.profile?.name });
      }
    }
  }
  return out;
}

/** Envía texto vía WhatsApp Cloud API. Fire-and-forget con error capturado. */
async function sendText(to, body) {
  const phone = normalize(to);
  if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId) {
    log.warn(`[wa] modo offline: no hay WA_ACCESS_TOKEN/WA_PHONE_NUMBER_ID. Mensaje a ${mask(phone)} NO enviado:\n---\n${body}\n---`);
    return { ok: false, reason: 'not-configured' };
  }
  try {
    const { data } = await axios.post(
      `${config.whatsapp.graphApiUrl}/${config.whatsapp.phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to: phone, type: 'text', text: { preview_url: false, body } },
      { headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` }, timeout: 15000 },
    );
    log.info(`[wa] enviado a ${mask(phone)} → ${data?.messages?.[0]?.id || 'ok'}`);
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (err) {
    const detail = err.response ? `${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}` : err.message;
    log.error(`[wa] fallo enviando a ${mask(phone)} →`, detail);
    return { ok: false, reason: detail };
  }
}

module.exports = { verifyWebhook, isValidSignature, parseIncoming, sendText };
