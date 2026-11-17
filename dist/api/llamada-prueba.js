"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.iniciarLlamadaPrueba = iniciarLlamadaPrueba;
const twilio_1 = __importDefault(require("twilio"));
const config_1 = require("../utils/config");
const twiml_1 = require("../twilio/twiml");
const telnyx = __importStar(require("../telnyx/api"));
const firma_1 = require("../telnyx/firma");
const relay_config_1 = require("../telnyx/relay-config");
const webhook_1 = require("../telnyx/webhook");
// ═══════════════════════════════════════════════════════════════════════════
// POST /api/llamada-prueba  (solo Odin, con VOICE_SERVER_SECRET)
//
// El dueño aprieta "Llamarme para probar" en el panel y su agente le marca.
// Del otro lado corre EXACTAMENTE la misma llamada que con un cliente: misma
// configuración, mismas herramientas, mismo cobro y la conversación entra a
// Odin. La única diferencia es la dirección: aquí la persona que contesta hace
// de "cliente" (su número es el `callerNumber`).
//
// Quién puede recibirla, cuántas por hora y que el negocio tenga línea lo
// decide Odin (`/api/voice/llamada-prueba`). Aquí solo se valida la forma.
// ═══════════════════════════════════════════════════════════════════════════
/** Límite duro de una llamada de prueba: nadie deja una línea abierta por error. */
const LIMITE_SEGUNDOS = 5 * 60;
function e164(n) {
    const s = String(n ?? "").trim();
    return /^\+[1-9]\d{9,14}$/.test(s) ? s : null;
}
async function iniciarLlamadaPrueba(req, res) {
    const numero = e164(req.body?.numero);
    const destino = e164(req.body?.destino);
    const proveedor = req.body?.proveedor === "telnyx" ? "telnyx" : "twilio";
    const voz = typeof req.body?.voz === "string" ? req.body.voz : "";
    if (!numero || !destino) {
        return res.status(400).json({ ok: false, error: "numero y destino en formato +52…" });
    }
    if (numero === destino) {
        return res.status(400).json({ ok: false, error: "La línea no puede llamarse a sí misma" });
    }
    // Como Twilio entrega el From: sin "+". Es lo que el pipeline usa como "quién llama".
    const caller = destino.replace("+", "");
    if (proveedor === "telnyx") {
        const connectionId = String(req.body?.connectionId || process.env.TELNYX_VOZ_CONNECTION_ID || "");
        if (!connectionId)
            return res.status(400).json({ ok: false, error: "Falta la Call Control App de Telnyx" });
        const firmado = (0, firma_1.firmarSaliente)({ n: numero, c: caller });
        const usarRelay = (0, relay_config_1.esVozTelnyx)(voz);
        const r = await telnyx.marcar({
            connectionId,
            to: destino,
            from: numero,
            timeLimitSecs: LIMITE_SEGUNDOS,
            ...(usarRelay
                ? {
                    relay: (0, relay_config_1.configRelay)({
                        url: (0, webhook_1.urlSalienteTelnyx)("relay-telnyx", firmado),
                        voz,
                        velocidad: req.body?.velocidadVoz,
                        ajustes: req.body?.ajustes,
                        parametros: (0, webhook_1.parametrosRelay)({ n: numero, c: caller, prueba: true }),
                    }),
                }
                : { streamUrl: (0, webhook_1.urlSalienteTelnyx)("ws-telnyx", firmado) }),
        });
        if (!r.ok) {
            console.error(`[PRUEBA] Telnyx no pudo marcar ${numero} → ${destino}: ${r.error}`);
            return res.status(502).json({ ok: false, error: r.error || "Telnyx no pudo marcar" });
        }
        console.log(`[PRUEBA] Marcando (Telnyx, motor ${usarRelay ? "Telnyx" : "OpenAI"}) ${numero} → ${destino} · ${r.callControlId}`);
        return res.json({ ok: true, llamadaId: r.callControlId || null, motor: usarRelay ? "relay" : "openai" });
    }
    if (!config_1.config.twilioAccountSid || !config_1.config.twilioAuthToken) {
        return res.status(503).json({ ok: false, error: "Faltan credenciales de Twilio en el voice server" });
    }
    try {
        const cliente = (0, twilio_1.default)(config_1.config.twilioAccountSid, config_1.config.twilioAuthToken);
        const llamada = await cliente.calls.create({
            to: destino,
            from: numero,
            twiml: (0, twiml_1.twimlLlamadaSaliente)({ numeroTwilio: numero, callerNumber: caller, base: (0, config_1.urlPublicaHttps)() }),
            timeout: 30,
            timeLimit: LIMITE_SEGUNDOS,
        });
        console.log(`[PRUEBA] Marcando (Twilio) ${numero} → ${destino} · ${llamada.sid}`);
        return res.json({ ok: true, llamadaId: llamada.sid, motor: "openai" });
    }
    catch (e) {
        console.error(`[PRUEBA] Twilio no pudo marcar ${numero} → ${destino}:`, e?.message || e);
        return res.status(502).json({ ok: false, error: e?.message || "Twilio no pudo marcar" });
    }
}
//# sourceMappingURL=llamada-prueba.js.map