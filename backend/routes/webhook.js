'use strict';
/**
 * routes/webhook.js — Capa HTTP del webhook de WhatsApp (Meta Cloud API).
 * Solo traduce HTTP <-> botController; no contiene logica de negocio.
 */
const express = require('express');
const wa = require('../services/whatsappService');
const bot = require('../services/botController');
const log = require('../utils/logger');

const router = express.Router();

/* Verificacion inicial exigida por Meta (handshake GET). */
router.get('/', (req, res) => {
  const challenge = wa.verifyWebhook({
    mode: req.query['hub.mode'],
    token: req.query['hub.verify_token'],
    challenge: req.query['hub.challenge'],
  });
  if (challenge === null || challenge === undefined) {
    log.warn('[webhook] verificacion fallida (token incorrecto)');
    return res.sendStatus(403);
  }
  res.status(200).send(String(challenge));
});

/*
 * Recepcion de mensajes. IMPORTANTE: necesitamos el raw body para validar la
 * firma HMAC, por eso se usa express.json({verify}) que deja req.rawBody.
 */
router.post('/',
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }),
  (req, res) => {
    if (!wa.isValidSignature(req.rawBody, req.get('x-hub-signature-256'))) {
      log.warn('[webhook] firma invalida: posible llamada suplantada');
      return res.sendStatus(401);
    }
    // Meta exige responder 200 RAPIDO (<20s) o reintenta y duplica mensajes.
    res.sendStatus(200);

    const messages = wa.parseIncoming(req.body);
    log.info(`[webhook] ${messages.length} mensaje(s) entrante(s)`);
    for (const m of messages) {
      bot.processIncoming(m).catch((err) => log.error('[webhook] fallo procesando mensaje:', err));
    }
  },
);

module.exports = router;
