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
async function warmupOdin() {
    try {
        const authHeader = config_1.config.voiceServerSecret
            ? { Authorization: `Bearer ${config_1.config.voiceServerSecret}` }
            : {};
        const resp = await fetch(`${config_1.config.odinAppUrl}/api/voice/config-llamada?negocioId=__warmup__`, {
            headers: authHeader,
            signal: AbortSignal.timeout(8000),
        });
        console.log(`[WARMUP] Odin respondió ${resp.status}`);
    }
    catch (err) {
        console.warn("[WARMUP] Odin no respondió:", err?.message || err);
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