'use strict';
/**
 * config/index.js — Única fuente de verdad para la configuración.
 *
 * Principio rectoro: NINGUNA API KEY VIVE EN EL FRONTEND.
 * Todo se lee de variables de entorno; si falta una, el sistema degrada
 * (salta ese proveedor de IA o entra en modo demo) en lugar de romper.
 */
require('dotenv').config();

const path = require('path');
const toInt = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 3000),

  ai: {
    timeoutMs: toInt(process.env.AI_TIMEOUT_MS, 20000),
    maxOutputTokens: toInt(process.env.AI_MAX_OUTPUT_TOKENS, 800),
    temperature: 0.4,
    historyWindow: 12, // nº máximo de mensajes que se pasan a la IA como contexto
    retry: { attempts: 2, baseDelayMs: 600 }, // reintento con backoff por proveedor
    providers: {
      gemini: {
        enabled: !!process.env.GEMINI_API_KEY,
        apiKey: process.env.GEMINI_API_KEY || '',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
        // Cadena de modelos: si uno devuelve 404/429/"retirado", se prueba el siguiente.
        models: list(process.env.GEMINI_MODELS).length
          ? list(process.env.GEMINI_MODELS)
          : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'],
      },
      groq: {
        enabled: !!process.env.GROQ_API_KEY,
        apiKey: process.env.GROQ_API_KEY || '',
        baseUrl: 'https://api.groq.com/openai/v1',
        models: list(process.env.GROQ_MODEL).length ? list(process.env.GROQ_MODEL) : ['llama-3.3-70b-versatile'],
      },
      openrouter: {
        enabled: !!process.env.OPENROUTER_API_KEY,
        apiKey: process.env.OPENROUTER_API_KEY || '',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: list(process.env.OPENROUTER_MODEL).length ? list(process.env.OPENROUTER_MODEL) : ['meta-llama/llama-3.3-70b-instruct'],
      },
    },
  },

  whatsapp: {
    verifyToken: process.env.WA_VERIFY_TOKEN || '',
    appSecret: process.env.WA_APP_SECRET || '',
    accessToken: process.env.WA_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID || '',
    graphApiUrl: process.env.WA_GRAPH_API_URL || 'https://graph.facebook.com/v21.0',
  },

  admin: { token: process.env.ADMIN_TOKEN || '' },
  corsOrigin: process.env.CORS_ORIGIN || '*',
  dataDir: path.resolve(__dirname, '..', process.env.DATA_DIR || './data'),
};
