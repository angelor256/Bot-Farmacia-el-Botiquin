'use strict';
/**
 * utils/logger.js — Logger mínimo con niveles y marcas de tiempo.
 * (En producción sustituir por pino/winston sin cambiar la firma.)
 */
const ts = () => new Date().toISOString();
const fmt = (args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');

module.exports = {
  info: (...a) => console.log(`[${ts()}] [INFO ]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [WARN ]`, fmt(a)),
  error: (...a) => console.error(`[${ts()}] [ERROR]`, fmt(a)),
  debug: (...a) => { if (process.env.NODE_ENV !== 'production') console.log(`[${ts()}] [DEBUG]`, ...a); },
};
