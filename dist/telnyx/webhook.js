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
Object.defineProperty(exports, "__esModule", { value: true });
exports.urlStreamTelnyx = urlStreamTelnyx;
exports.despedirYColgar = despedirYColgar;
exports.purgarContestosViejos = purgarContestosViejos;
exports.crearWebhookTelnyx = crearWebhookTelnyx;
const config_1 = require("../utils/config");
const transferencias_1 = require("../api/transferencias");
const telnyx = __importStar(require("./api"));
const firma_1 = require("./firma");
const eventos_1 = require("./eventos");
// ═══════════════════════════════════════════════════════════════════════════
// POST /telnyx/webhook — el "/twiml" de Telnyx.
//
// Todos los avisos de Call Control de nuestros números de Telnyx llegan aquí
// (la URL se pone una vez en la Call Control Application del portal). Hacemos
// lo mismo que Twilio + nuestro TwiML, en eventos:
//
//   call.initiated (entrante) → ¿agente o línea apagados? rechazar (ocupado,
//                               sin costo). Si no, contestar y abrir el audio
//                               hacia /ws-telnyx con el contexto en client_state.
//   call.answered  (pierna de transferencia) → anotar a qué hora contestó el humano.
//   call.hangup    (pierna de transferencia) → cobrar el tramo humano en Odin
//                               (/api/webhooks/voice-transferencia, igual que
//                               /transferencia-estado de Twilio) y colgar al cliente.
//   call.speak.ended (despedida) → colgar.
//   streaming.failed → el audio no conectó: despedir y colgar (el
//                               /twiml-fallback de Twilio).
//
// Respondemos 200 de inmediato y trabajamos después: Telnyx reintenta si
// tardamos, y un reintento de `call.initiated` contestaría dos veces (lo frena
// el `command_id`, pero mejor no provocarlo).
// ═══════════════════════════════════════════════════════════════════════════
/** Ruta del WebSocket de audio, con el token de esta llamada. */
function urlStreamTelnyx(callControlId) {
    const base = (0, config_1.urlPublicaHttps)().replace(/^https:/, "wss:");
    const q = new URLSearchParams({ ccid: callControlId, t: (0, firma_1.tokenStream)(callControlId) });
    return `${base}/ws-telnyx?${q.toString()}`;
}
const DESPEDIDA = "Lo sentimos, en este momento no podemos atender su llamada. Por favor intente de nuevo en unos minutos o escríbanos por WhatsApp.";
/** Despide con voz y cuelga al terminar; si Telnyx no puede hablar, cuelga ya. */
async function despedirYColgar(callControlId) {
    const r = await telnyx.hablar(callControlId, DESPEDIDA, (0, eventos_1.codificarEstado)({ k: "colgar" }));
    if (!r.ok) {
        console.error(`[TELNYX] No se pudo decir la despedida (${r.error}) — colgando directo`);
        await telnyx.colgar(callControlId);
    }
}
/**
 * Pregunta a Odin, ANTES de contestar, si esta línea debe contestar. Usa el
 * mismo `config-llamada` (que lee la base en ese momento) en su modo ligero.
 * Si Odin no responde a tiempo, devuelve null y se contesta: el pipeline vuelve
 * a preguntar con reintentos y, si sigue sin poder, se despide. Perder una
 * llamada de un cliente por un timeout nuestro sería peor que unos segundos de
 * línea.
 */
async function consultarGate(numero, caller) {
    const params = new URLSearchParams({ numeroTwilio: numero, soloGate: "1" });
    if (caller)
        params.set("callerNumber", caller);
    try {
        const resp = await fetch(`${config_1.config.odinAppUrl}/api/voice/config-llamada?${params.toString()}`, {
            headers: config_1.config.voiceServerSecret ? { Authorization: `Bearer ${config_1.config.voiceServerSecret}` } : {},
            signal: AbortSignal.timeout(2500),
        });
        if (!resp.ok)
            return null;
        return (await resp.json().catch(() => null));
    }
    catch (e) {
        console.warn("[TELNYX] Gate de Odin no respondió a tiempo — se contesta igual:", e instanceof Error ? e.message : e);
        return null;
    }
}
async function atenderEntrante(p) {
    const ccid = String(p?.call_control_id || "");
    const numero = (0, eventos_1.normalizarE164)(p?.to);
    const caller = (0, eventos_1.numeroLlamante)(p?.from);
    const forwardedFrom = (0, eventos_1.numeroDeDiversion)(p?.sip_headers);
    console.log(`[TELNYX] Llamada entrante → numero: ${numero || "?"}, caller: ${caller || "desconocido"}${forwardedFrom ? `, forwardedFrom: ${forwardedFrom}` : ""}`);
    const gate = await consultarGate(numero, caller);
    if ((0, eventos_1.debeRechazarSinContestar)(gate)) {
        const r = await telnyx.rechazar(ccid);
        console.log(`[TELNYX] ${numero}: ${gate?.motivo} → rechazada sin contestar${r.ok ? "" : ` (fallo: ${r.error})`}`);
        return;
    }
    const r = await telnyx.contestar(ccid, {
        streamUrl: urlStreamTelnyx(ccid),
        clientState: (0, eventos_1.codificarEstado)({ k: "in", n: numero, c: caller, f: forwardedFrom }),
    });
    if (!r.ok)
        console.error(`[TELNYX] No se pudo contestar ${ccid}: ${r.error}`);
}
// Pierna del humano en una transferencia → cuándo contestó (para medir el tramo).
const humanoContesto = new Map();
// Por si una pierna nunca manda hangup: se purga con las transferencias viejas.
const TTL_MS = 6 * 60 * 60 * 1000;
function purgarContestosViejos() {
    const limite = Date.now() - TTL_MS;
    for (const [id, ms] of humanoContesto)
        if (ms < limite)
            humanoContesto.delete(id);
}
async function procesarEvento(evento, alTerminarTransferencia) {
    const tipo = String(evento?.event_type || "");
    const p = evento?.payload || {};
    const ccid = String(p?.call_control_id || "");
    const estado = (0, eventos_1.decodificarEstado)(p?.client_state);
    switch (tipo) {
        case "call.initiated": {
            // Las salientes son nuestras (la pierna de una transferencia): no se contestan.
            if (p?.direction === "incoming")
                await atenderEntrante(p);
            return;
        }
        case "call.answered": {
            if (estado?.k === "tr") {
                humanoContesto.set(ccid, (0, eventos_1.msDe)(evento?.occurred_at) ?? Date.now());
                console.log(`[TRANSFER] Humano contestó (pierna ${ccid}) → cliente ${estado.a}`);
            }
            return;
        }
        case "call.hangup": {
            if (estado?.k !== "tr")
                return; // colgó el cliente: el WebSocket cierra solo y el pipeline cobra.
            const contesto = humanoContesto.get(ccid) ?? null;
            humanoContesto.delete(ccid);
            const segundos = (0, eventos_1.segundosConHumano)(contesto, (0, eventos_1.msDe)(evento?.occurred_at) ?? Date.now());
            const causa = String(p?.hangup_cause || "");
            // Como en Twilio (<Dial> sin más verbos): al terminar el tramo humano, la
            // llamada del cliente se acaba. Si el humano no contestó, Telnyx deja al
            // cliente en una línea sin audio: colgamos. Si ya colgó, el 422 no importa.
            telnyx.colgar(estado.a).catch(() => { });
            const transferencia = (0, transferencias_1.tomarTransferencia)(estado.a);
            if (!transferencia) {
                console.warn(`[TRANSFER] Fin de pierna sin transferencia registrada: ${estado.a} — ignorado`);
                return;
            }
            console.log(`[TRANSFER] ${estado.a} → ${transferencia.destino}: ${segundos}s con humano (${causa || "?"})`);
            await alTerminarTransferencia(transferencia, segundos, segundos > 0 ? "completed" : causa || "no-answer");
            return;
        }
        case "call.speak.ended": {
            if (estado?.k === "colgar")
                await telnyx.colgar(ccid);
            return;
        }
        case "streaming.failed": {
            console.error(`[TELNYX] El audio no conectó para ${ccid}:`, JSON.stringify(p).slice(0, 300));
            await despedirYColgar(ccid);
            return;
        }
        default:
            return;
    }
}
function crearWebhookTelnyx(alTerminarTransferencia) {
    return function webhookTelnyx(req, res) {
        if (!config_1.config.telnyxPublicKey) {
            console.error("[TELNYX] Falta TELNYX_PUBLIC_KEY: se rechaza el aviso (no se puede verificar quién lo manda).");
            res.status(503).json({ error: "no_configurado" });
            return;
        }
        const crudo = req.rawBody?.toString("utf8") ?? "";
        const valida = (0, firma_1.verificarFirmaTelnyx)(crudo, req.get("telnyx-signature-ed25519"), req.get("telnyx-timestamp"), config_1.config.telnyxPublicKey);
        if (!valida) {
            console.error("[TELNYX] Firma inválida en /telnyx/webhook");
            res.status(401).json({ error: "firma_invalida" });
            return;
        }
        res.sendStatus(200);
        const evento = req.body?.data;
        procesarEvento(evento, alTerminarTransferencia).catch((e) => console.error("[TELNYX] Error procesando aviso:", e instanceof Error ? e.message : e));
    };
}
//# sourceMappingURL=webhook.js.map