'use strict';
/**
 * utils/phone.js — Normalización de números de teléfono de WhatsApp.
 *
 * El mismo cliente puede aparecer como "50688880000", "+506 8888-0000",
 * "50688880000@c.us" o "tel:+50688880000". Si no normalizamos, el historial
 * y la pausa del bot se rompen (clave de los objetivos #2 y #3).
 */

/** Devuelve solo dígitos; quita sufijos JID y prefijos internacionales 00. */
function normalize(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  s = s.replace(/@c\.us.*$/i, '').replace(/^tel:\+?/i, ''); // sufijos de WhatsApp / tel:
  s = s.replace(/[^\d+]/g, '');                              // espacios, guiones, paréntesis
  s = s.replace(/^\+/, '');
  if (/^00\d{10,}$/.test(s)) s = s.slice(2);                 // 00506... -> 506...
  return s;
}

/** Comparación tolerante: ignora formato y diferencias de prefijo de país. */
function same(a, b) {
  const x = normalize(a), y = normalize(b);
  return !!x && !!y && (x === y || x.endsWith(y) || y.endsWith(x));
}

/** Enmascara para logs (privacidad): +5068•••••000 */
function mask(raw) {
  const n = normalize(raw);
  if (n.length < 6) return '****';
  return `+${n.slice(0, 3)}${'*'.repeat(Math.max(0, n.length - 6))}${n.slice(-3)}`;
}

module.exports = { normalize, same, mask };
