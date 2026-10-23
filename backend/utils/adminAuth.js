'use strict';
const config = require('../config');

/* Autenticacion de las rutas administrativas via cabecera X-Admin-Token. */
function requireAdmin(req, res, next) {
  if (!config.admin.token) return next(); // sin token configurado (dev) = abierto
  if (req.get('x-admin-token') === config.admin.token) return next();
  return res.status(401).json({ error: 'No autorizado: falta o es invalido el header X-Admin-Token' });
}

module.exports = requireAdmin;
