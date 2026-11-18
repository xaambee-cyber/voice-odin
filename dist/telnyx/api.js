"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contestar = contestar;
exports.contestarConRelay = contestarConRelay;
exports.limpiarAudio = limpiarAudio;
exports.detenerRelay = detenerRelay;
exports.marcar = marcar;
exports.rechazar = rechazar;
exports.colgar = colgar;
exports.hablar = hablar;
exports.transferir = transferir;
exports.detenerStream = detenerStream;
const config_1 = require("../utils/config");
// ═══════════════════════════════════════════════════════════════════════════
// Comandos de Call Control de Telnyx (https://api.telnyx.com/v2/calls/…).
//
// Es el equivalente de `client.calls(sid).update(...)` de Twilio: aquí cada
// acción es su propio endpoint. Nunca lanzan: devuelven { ok, status, error }
// para que el pipeline decida (igual que con Twilio, un fallo al colgar o al
// transferir NO debe tumbar la llamada).
// ═══════════════════════════════════════════════════════════════════════════
const BASE = "https://api.telnyx.com/v2";
function resumenError(json) {
    const errores = json?.errors;
    if (!Array.isArray(errores) || errores.length === 0)
        return "";
    return errores
        .map((e) => [e.code, e.title, e.detail].filter(Boolean).join(" · "))
        .join(" | ")
        .slice(0, 400);
}
async function comando(callControlId, accion, cuerpo = {}, timeoutMs = 8000) {
    if (!config_1.config.telnyxApiKey)
        return { ok: false, status: 0, error: "Falta TELNYX_API_KEY" };
    if (!callControlId)
        return { ok: false, status: 0, error: "Sin call_control_id" };
    try {
        const r = await fetch(`${BASE}/calls/${encodeURIComponent(callControlId)}/actions/${accion}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config_1.config.telnyxApiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(cuerpo),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (r.ok)
            return { ok: true, status: r.status };
        const json = await r.json().catch(() => null);
        return { ok: false, status: r.status, error: resumenError(json) || `HTTP ${r.status}` };
    }
    catch (e) {
        return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
}
/**
 * Contesta y abre el audio bidireccional hacia /ws-telnyx.
 *  - `stream_codec: PCMU` fuerza μ-law 8 kHz en lo que RECIBIMOS (si no, Telnyx
 *    manda el códec de la llamada, que puede ser G.722 o PCMA) — OpenAI está
 *    configurado en `audio/pcmu`, igual que con Twilio.
 *  - `stream_bidirectional_mode: rtp` + `PCMU`: lo que MANDAMOS son los mismos
 *    bytes μ-law que OpenAI entrega, sin convertir. Los sonidos pregenerados
 *    (tecleo, ambiente) también son μ-law y sirven tal cual.
 *  - `stream_track: inbound_track`: solo la voz del cliente, como Twilio.
 */
function contestar(callControlId, opts) {
    return comando(callControlId, "answer", {
        stream_url: opts.streamUrl,
        stream_track: "inbound_track",
        stream_codec: "PCMU",
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: "PCMU",
        client_state: opts.clientState,
        command_id: `answer-${callControlId}`,
    });
}
/**
 * Contesta con el motor de voz de TELNYX (Conversation Relay): Telnyx
 * transcribe y habla con sus voces; a nosotros solo nos llega texto por el
 * WebSocket de `relay.url`. No se abre el stream de audio de OpenAI.
 */
function contestarConRelay(callControlId, opts) {
    return comando(callControlId, "answer", {
        conversation_relay_config: opts.relay,
        client_state: opts.clientState,
        // Distinto del `answer` normal: si Telnyx rechaza el relay, el plan B
        // (contestar con el stream de OpenAI) no puede chocar con este command_id.
        command_id: `answer-relay-${callControlId}`,
    });
}
/**
 * Enciende la limpieza de la voz del cliente (eco y voz baja; ver
 * `intentosSupresion`). Prueba cada combinación hasta que Telnyx acepte una.
 * Devuelve el motor que quedó, o null. Nunca lanza: sin limpieza la llamada
 * sigue igual que antes.
 */
async function limpiarAudio(callControlId, intentos) {
    let ultimoError = "";
    for (let i = 0; i < intentos.length; i++) {
        const r = await comando(callControlId, "suppression_start", {
            ...intentos[i],
            command_id: `supresion-${i}-${callControlId}`,
        });
        if (r.ok)
            return { motor: String(intentos[i].noise_suppression_engine) };
        ultimoError = r.error || `HTTP ${r.status}`;
        // La llamada ya no existe o no hay llave: no tiene caso seguir probando.
        if (r.status === 0 || r.status === 404 || r.status === 401)
            break;
    }
    return { motor: null, error: ultimoError };
}
/** Termina Conversation Relay en la llamada (Telnyx cierra nuestro WebSocket). */
function detenerRelay(callControlId) {
    return comando(callControlId, "conversation_relay_stop", { command_id: `relay-stop-${callControlId}` });
}
/**
 * Llamada SALIENTE (la de prueba del panel). `stream` o `relay` deciden el
 * motor igual que al contestar una entrante; los dos arrancan solos cuando la
 * persona contesta. `time_limit_secs` corta la llamada pase lo que pase.
 */
async function marcar(opts) {
    if (!config_1.config.telnyxApiKey)
        return { ok: false, status: 0, error: "Falta TELNYX_API_KEY" };
    const cuerpo = {
        connection_id: opts.connectionId,
        to: opts.to,
        from: opts.from,
        timeout_secs: 30,
        time_limit_secs: opts.timeLimitSecs,
    };
    if (opts.relay)
        cuerpo.conversation_relay_config = opts.relay;
    else if (opts.streamUrl) {
        Object.assign(cuerpo, {
            stream_url: opts.streamUrl,
            stream_track: "inbound_track",
            stream_codec: "PCMU",
            stream_bidirectional_mode: "rtp",
            stream_bidirectional_codec: "PCMU",
        });
    }
    try {
        const r = await fetch(`${BASE}/calls`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config_1.config.telnyxApiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(cuerpo),
            signal: AbortSignal.timeout(10_000),
        });
        const json = (await r.json().catch(() => null));
        if (!r.ok)
            return { ok: false, status: r.status, error: resumenError(json) || `HTTP ${r.status}` };
        return { ok: true, status: r.status, callControlId: json?.data?.call_control_id };
    }
    catch (e) {
        return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
}
/** Rechaza SIN contestar: el cliente oye ocupado y no se cobra la llamada. */
function rechazar(callControlId) {
    return comando(callControlId, "reject", { cause: "USER_BUSY", command_id: `reject-${callControlId}` });
}
function colgar(callControlId) {
    return comando(callControlId, "hangup", { command_id: `hangup-${callControlId}` });
}
/**
 * Habla con la voz Polly.Mia (la misma del <Say> de Twilio) — solo para la
 * despedida cuando el agente no está disponible. `clientState` permite colgar
 * al terminar (`call.speak.ended`).
 */
function hablar(callControlId, texto, clientState) {
    return comando(callControlId, "speak", {
        payload: texto,
        payload_type: "text",
        voice: "Polly.Mia",
        language: "es-MX",
        client_state: clientState,
        command_id: `speak-${callControlId}`,
    });
}
/**
 * Pasa la llamada a un humano: Telnyx marca a `to` y, cuando contesta, lo une
 * con el cliente (que mientras oye el timbre: `early_media`). Es el <Dial
 * answerOnBridge> de Twilio. `from` debe ser nuestro número de Telnyx —el
 * equivalente del callerId— y `targetLegClientState` marca la pierna nueva
 * para medir cuánto habló el humano (se cobra aparte, como en Twilio).
 */
function transferir(callControlId, opts) {
    return comando(callControlId, "transfer", {
        to: opts.to,
        from: opts.from,
        timeout_secs: opts.timeoutSecs,
        early_media: true,
        target_leg_client_state: opts.targetLegClientState,
        command_id: `transfer-${callControlId}`,
    });
}
/** Cierra el audio hacia el agente (Telnyx manda "stop" al WebSocket). */
function detenerStream(callControlId) {
    return comando(callControlId, "streaming_stop", { command_id: `streaming-stop-${callControlId}` });
}
//# sourceMappingURL=api.js.map