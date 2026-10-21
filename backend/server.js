'use strict';
/**
 * server.js — Punto de entrada: montaje del servidor Express.
 * No contiene logica de negocio (solo wiring HTTP).
 */
const path = require('path');
const express = require('express');
const config = require('./config');
const log = require('./utils/logger');
const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');

const app = express();

/* Seguridad basica en la capa HTTP */
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* El webhook necesita el raw body para validar la firma: se monta ANTES del json() global. */
app.use('/webhook', webhookRoutes);
app.use(express.json({ limit: '1mb' }));
app.use('/api', apiRoutes);

/* Panel estatico (index.html refactorizado + frontend/js) */
const webRoot = path.resolve(__dirname, '..');
app.use(express.static(webRoot, { extensions: ['html'] }));

/* 404 y manejador de errores centralizado */
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada', path: req.originalUrl }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('[http] error no capturado:', err);
  res.status(err.status || 500).json({ error: config.env === 'production' ? 'Error interno' : err.message });
});

if (require.main === module) {
  const aiHealth = require('./services/aiService').health();
  app.listen(config.port, () => {
    log.info(`Panel + bot escuchando en http://localhost:${config.port} (${config.env})`);
    log.info(`IA proveedores activos: ${aiHealth.configured.map((c) => c.provider).join(', ') || 'NINGUNO (modo fallback local)'}`);
    if (!config.whatsapp.accessToken) log.warn('WA_ACCESS_TOKEN vacio: el bot funciona en modo simulacion (no envia a WhatsApp real).');
  });
}

module.exports = app;
