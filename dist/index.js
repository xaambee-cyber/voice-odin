"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const crypto_1 = require("crypto");
const http_1 = require("http");
const ws_1 = require("ws");
const config_1 = require("./utils/config");
const twiml_1 = require("./twilio/twiml");
const configurar_1 = require("./api/configurar");
const preview_voz_1 = require("./api/preview-voz");
const registro_voz_1 = require("./api/registro-voz");
const transferencias_1 = require("./api/transferencias");
const llamada_1 = require("./pipeline/llamada");
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// CORS — permitir que el panel de Odin llame al voice server (preview de voz).
// Permitimos *.vercel.app y xambee.com (con/sin www).
function originPermitido(origin) {
    if (!origin)
        return false;
    try {
        const host = new URL(origin).hostname.toLowerCase();
        return host.endsWith(".vercel.app") || host === "xambee.com" || host.endsWith(".xambee.com");
    }
    catch {
        return false;
    }
}
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (originPermitido(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS")
        return res.sendStatus(204);
    next();
});
// Guard de secreto compartido para endpoints internos (server-to-server).
// Valida `Authorization: Bearer <VOICE_SERVER_SECRET>` con comparación de
// tiempo constante. Si el secreto NO está configurado (dev local), no bloquea
// para no romper el flujo de desarrollo. En prod VOICE_SERVER_SECRET es
// obligatorio, así que sí protege.
function requireSecret(req, res, next) {
    const secret = config_1.config.voiceServerSecret;
    if (!secret)
        return next(); // dev sin secreto
    const auth = req.headers.authorization || "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const a = Buffer.from(token);
    const b = Buffer.from(secret);
    const ok = a.length === b.length && (0, crypto_1.timingSafeEqual)(a, b);
    if (!ok)
        return res.status(401).json({ error: "No autorizado" });
    next();
}
// ═══ API REST ═══
app.get("/", (req, res) => {
    res.json({
        servicio: "odin-voice",
        estado: "online",
        version: "1.1.0",
    });
});
// Twilio llama aquí cuando entra una llamada → devuelve TwiML
app.post("/twiml", twiml_1.handleIncomingCall);
app.get("/twiml", twiml_1.handleIncomingCall);
// Fallback si el WebSocket no conecta
app.post("/twiml-fallback", twiml_1.handleFallback);
// ═══ Fin de una transferencia a humano ═══
// Lo llama TWILIO (no Odin): es el `statusCallback` del <Number> dentro del
// <Dial>, con `statusCallbackEvent="completed"`. Reporta cuánto duró el tramo
// humano — el que sigue facturando dos piernas de Twilio después de que la IA
// salió de la línea — para que Odin lo cobre a tarifa de solo telefonía.
//
// Es un callback de la pierna HIJA, así que dispara sin importar quién colgó
// primero. (El `action` del <Dial> no sirve para esto: solo corre si la llamada
// padre sigue viva, y si el cliente cuelga primero nunca llega.)
//
// No lleva `requireSecret`: quien pega aquí es Twilio, que no puede portar
// nuestro bearer. La protección real es el mapa de transferencias en vuelo — un
// ParentCallSid que no salió de un <Dial> nuestro no existe ahí y se ignora.
app.post("/transferencia-estado", (req, res) => {
    // En el callback de la hija, CallSid es la pierna saliente y ParentCallSid la
    // llamada original del cliente — que es la que conoce Odin.
    const callSidPadre = String(req.body?.ParentCallSid || "");
    const estado = String(req.body?.CallStatus || "");
    const duracionSegundos = parseInt(String(req.body?.CallDuration || "0"), 10) || 0;
    // Twilio solo necesita un 2xx; no hay TwiML que devolver aquí. Respondemos ya
    // y reportamos a Odin sin bloquear.
    res.sendStatus(204);
    const transferencia = (0, transferencias_1.tomarTransferencia)(callSidPadre);
    if (!transferencia) {
        console.warn(`[TRANSFER] Callback sin transferencia registrada: parent=${callSidPadre || "?"} — ignorado`);
        return;
    }
    console.log(`[TRANSFER] ${callSidPadre} → ${transferencia.destino}: ${duracionSegundos}s con humano (${estado || "?"})`);
    reportarTransferencia(transferencia, duracionSegundos, estado).catch((e) => console.error("[TRANSFER] Error reportando a Odin:", e?.message || e));
});
/**
 * Manda a Odin la duración del tramo humano para que lo cobre. Con reintentos
 * por la misma razón que el webhook de cierre: si esto se pierde, el negocio usó
 * telefonía que nadie pagó. Odin dedupea por `transferencia_segundos`, así que
 * reintentar nunca cobra dos veces.
 */
async function reportarTransferencia(transferencia, duracionSegundos, estado) {
    const payload = JSON.stringify({
        callSid: transferencia.callSid,
        negocioId: transferencia.negocioId,
        duracionSegundos,
        estado,
    });
    const ESPERAS_MS = [0, 4000, 15_000, 60_000];
    for (let intento = 1; intento <= ESPERAS_MS.length; intento++) {
        if (ESPERAS_MS[intento - 1] > 0) {
            await new Promise((r) => setTimeout(r, ESPERAS_MS[intento - 1]));
        }
        try {
            const resp = await fetch(`${config_1.config.odinAppUrl}/api/webhooks/voice-transferencia`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(config_1.config.voiceServerSecret
                        ? { Authorization: `Bearer ${config_1.config.voiceServerSecret}` }
                        : {}),
                },
                body: payload,
                signal: AbortSignal.timeout(20_000),
            });
            const data = await resp.json().catch(() => ({}));
            if (resp.ok) {
                // `sinConversacion` = el webhook de cierre todavía no creó la
                // conversación (sigue reintentando). Reintentamos para alcanzarlo.
                if (data?.sinConversacion && intento < ESPERAS_MS.length) {
                    console.warn(`[TRANSFER] Conversación aún no existe (intento ${intento}) — reintentando`);
                    continue;
                }
                console.log(`[TRANSFER] Odin → ${resp.status} (intento ${intento}):`, data);
                return;
            }
            console.warn(`[TRANSFER] Odin HTTP ${resp.status} (intento ${intento}):`, data);
            if (resp.status >= 400 && resp.status < 500)
                return; // payload/config mal
        }
        catch (err) {
            console.warn(`[TRANSFER] Odin falló (intento ${intento}):`, err?.message || err);
        }
    }
    console.error(`[TRANSFER] AGOTÓ reintentos — tramo humano de ${transferencia.callSid} sin cobrar`);
}
// API para Odin (server-to-server → requieren secreto compartido)
app.post("/api/configurar", requireSecret, configurar_1.configurarNegocio);
app.get("/api/estado/:negocioId", requireSecret, configurar_1.obtenerEstado);
app.get("/api/negocios", requireSecret, configurar_1.listarNegocios);
app.post("/api/set-voz", requireSecret, registro_voz_1.setVozHandler);
// preview-voz lo llama el browser del panel (no puede portar el secreto);
// se protege con allowlist de voces + cache (costo acotado).
app.get("/api/preview-voz", preview_voz_1.previewVoz);
// ═══ WebSocket Server ═══
const server = (0, http_1.createServer)(app);
const wss = new ws_1.WebSocketServer({ server, path: "/ws" });
const llamadasActivas = new Map();
wss.on("connection", (ws) => {
    console.log("[WS] Nueva conexión WebSocket de Twilio");
    let pipeline = null;
    let callSid = "";
    ws.on("message", async (data) => {
        try {
            const mensaje = JSON.parse(data.toString());
            if (mensaje.event === "connected") {
                console.log("[WS] Twilio conectado al stream");
                return;
            }
            if (mensaje.event === "start") {
                callSid = mensaje.start?.callSid || "";
                const params = mensaje.start?.customParameters || {};
                const negocioId = String(params.negocioId || "");
                const numeroTwilio = String(params.numeroTwilio || "");
                const callerNumber = String(params.callerNumber || "");
                const forwardedFrom = String(params.forwardedFrom || "");
                const configNegocio = (0, configurar_1.obtenerConfig)(negocioId || "default");
                console.log(`[WS] Llamada ${callSid} → negocioId: ${negocioId || "(lookup)"}, numeroTwilio: ${numeroTwilio || "?"}, caller: ${callerNumber || "desconocido"}${forwardedFrom ? `, forwardedFrom: ${forwardedFrom}` : ""}`);
                pipeline = new llamada_1.PipelineLlamada(ws, negocioId, configNegocio, callerNumber, numeroTwilio, callSid, forwardedFrom);
                // Registrar el streamSid ANTES de conectar a OpenAI para que el saludo no se descarte
                pipeline.recibirMensajeTwilio(mensaje);
                await pipeline.iniciar();
                llamadasActivas.set(callSid, pipeline);
                return;
            }
            if (pipeline) {
                pipeline.recibirMensajeTwilio(mensaje);
            }
        }
        catch (err) {
            console.error("[WS] Error procesando mensaje:", err);
        }
    });
    ws.on("close", () => {
        console.log(`[WS] Conexión cerrada — callSid: ${callSid}`);
        // Red de seguridad: si el WS murió SIN evento "stop" (p. ej. colgamos
        // nosotros por fallo del REST de Twilio, o se cayó la conexión), la
        // llamada se finaliza igual — transcripción, nombre y créditos JAMÁS se
        // pierden. Es idempotente: si "stop" ya la finalizó, no hace nada.
        pipeline?.finalizarPorCierreDeSocket();
        if (callSid) {
            llamadasActivas.delete(callSid);
        }
    });
    ws.on("error", (err) => {
        console.error("[WS] Error:", err);
    });
});
// ═══ Warmup periódico de Vercel ═══
// Cada 4 minutos hacemos un ping al endpoint de config para mantener la
// función serverless caliente. Sin esto, una llamada que entra después de
// rato encuentra Vercel frío y el fetch tarda 3-5s extra.
const WARMUP_MS = 4 * 60 * 1000;
// Aviso temprano de env incompleto: sin las credenciales de Twilio fallan
// colgar_llamada, las TRANSFERENCIAS a humano y el rechazo por saldo (visto
// en prod como "error con Twilio API: Authenticate"). Mejor gritarlo al
// arrancar que descubrirlo a media llamada.
if (!config_1.config.twilioAccountSid || !config_1.config.twilioAuthToken) {
    console.error("⚠️  [CONFIG] Faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN — colgar, transferir y rechazar por saldo NO funcionarán");
}
// ═══ SLA de escalamientos ═══
// Vercel Hobby solo permite crons DIARIOS, así que este server (siempre
// encendido) hace de scheduler fino: cada 30 min dispara el cron de Odin que
// re-notifica al gerente las solicitudes pendientes sin responder. El
// endpoint es idempotente (respeta sus propios intervalos), así que llamarlo
// de más no duplica recordatorios.
const SLA_MS = 30 * 60 * 1000;
async function dispararSlaEscalamientos() {
    if (!config_1.config.voiceServerSecret)
        return; // dev sin secreto: no hay cómo autenticar
    try {
        const resp = await fetch(`${config_1.config.odinAppUrl}/api/cron/escalamientos`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config_1.config.voiceServerSecret}` },
            signal: AbortSignal.timeout(110_000),
        });
        const data = await resp.json().catch(() => ({}));
        console.log(`[SLA] escalamientos → ${resp.status}`, data);
    }
    catch (err) {
        console.warn("[SLA] escalamientos falló:", err?.message || err);
    }
}
setInterval(dispararSlaEscalamientos, SLA_MS);
setTimeout(dispararSlaEscalamientos, 60_000); // primer barrido al minuto del arranque
// Transferencias que nunca recibieron su callback de Twilio: se purgan a las 6 h
// para que el mapa no crezca sin límite.
setInterval(transferencias_1.purgarTransferenciasViejas, 60 * 60 * 1000);
// ═══ Benchmarks por giro ═══
// Igual que el SLA: sin Vercel Cron (todo vive en VPS), este server dispara el
// recálculo de snapshots/cohortes. Cada 6 h es de sobra (los datos son del mes
// en curso y el endpoint es idempotente).
const BENCHMARKS_MS = 6 * 60 * 60 * 1000;
async function dispararBenchmarks() {
    if (!config_1.config.voiceServerSecret)
        return;
    try {
        const resp = await fetch(`${config_1.config.odinAppUrl}/api/cron/benchmarks`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config_1.config.voiceServerSecret}` },
            signal: AbortSignal.timeout(280_000),
        });
        const data = await resp.json().catch(() => ({}));
        console.log(`[BENCHMARKS] → ${resp.status}`, data);
    }
    catch (err) {
        console.warn("[BENCHMARKS] falló:", err?.message || err);
    }
}
setInterval(dispararBenchmarks, BENCHMARKS_MS);
setTimeout(dispararBenchmarks, 3 * 60_000); // primer cálculo a los 3 min del arranque
// En VPS ya no hay cold start que calentar: esto quedó como HEARTBEAT de que
// Odin está vivo (usa /api/health, público). Solo hace ruido si algo va mal.
async function warmupOdin() {
    try {
        const resp = await fetch(`${config_1.config.odinAppUrl}/api/health`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok)
            console.warn(`[HEARTBEAT] Odin respondió ${resp.status}`);
    }
    catch (err) {
        console.warn("[HEARTBEAT] Odin no respondió:", err?.message || err);
    }
}
setInterval(warmupOdin, WARMUP_MS);
// ═══ Iniciar servidor ═══
server.listen(config_1.config.port, () => {
    console.log(`
╔════════════════════════════════════════════╗
║           ODIN VOICE SERVER                ║
║                                            ║
║   Puerto:  ${config_1.config.port}                         ║
║   WS:      ${config_1.config.voiceServerUrl}/ws     ║
║   Estado:  ONLINE                          ║
╚════════════════════════════════════════════╝
  `);
    // Primer warmup a los 30s del arranque
    setTimeout(warmupOdin, 30_000);
});
//# sourceMappingURL=index.js.map