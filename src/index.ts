// IMPORTANTE: importar primero http.ts para que el keep-alive global
// se configure antes de cualquier fetch a Odin.
import "./utils/http";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./utils/config";
import { handleIncomingCall, handleFallback } from "./twilio/twiml";
import { configurarNegocio, obtenerEstado, obtenerConfig, listarNegocios } from "./api/configurar";
import { previewVoz } from "./api/preview-voz";
import { invalidarCacheHandler } from "./api/invalidar-cache";
import { PipelineLlamada } from "./pipeline/llamada";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — permitir que el panel de Odin llame al voice server (preview de voz).
// Permitimos *.vercel.app y xambee.com (con/sin www).
function originPermitido(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host.endsWith(".vercel.app") || host === "xambee.com" || host === "www.xambee.com";
  } catch {
    return false;
  }
}
app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (originPermitido(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin!);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ═══ API REST ═══

app.get("/", (req, res) => {
  res.json({
    servicio: "odin-voice",
    estado: "online",
    version: "1.1.0",
  });
});

// Twilio llama aquí cuando entra una llamada → devuelve TwiML
app.post("/twiml", handleIncomingCall);
app.get("/twiml", handleIncomingCall);

// Fallback si el WebSocket no conecta
app.post("/twiml-fallback", handleFallback);

// API para Odin
app.post("/api/configurar", configurarNegocio);
app.get("/api/estado/:negocioId", obtenerEstado);
app.get("/api/negocios", listarNegocios);
app.get("/api/preview-voz", previewVoz);
app.post("/api/invalidar-cache", invalidarCacheHandler);

// ═══ WebSocket Server ═══

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const llamadasActivas: Map<string, PipelineLlamada> = new Map();

wss.on("connection", (ws: WebSocket) => {
  console.log("[WS] Nueva conexión WebSocket de Twilio");

  let pipeline: PipelineLlamada | null = null;
  let callSid: string = "";

  ws.on("message", async (data: Buffer) => {
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
        const configNegocio = obtenerConfig(negocioId || "default");

        console.log(`[WS] Llamada ${callSid} → negocioId: ${negocioId || "(lookup)"}, numeroTwilio: ${numeroTwilio || "?"}, caller: ${callerNumber || "desconocido"}`);

        pipeline = new PipelineLlamada(
          ws,
          negocioId,
          configNegocio,
          callerNumber,
          numeroTwilio,
          callSid,
        );
        // Registrar el streamSid ANTES de conectar a OpenAI para que el saludo no se descarte
        pipeline.recibirMensajeTwilio(mensaje);
        await pipeline.iniciar();
        llamadasActivas.set(callSid, pipeline);
        return;
      }

      if (pipeline) {
        pipeline.recibirMensajeTwilio(mensaje);
      }
    } catch (err) {
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

// ═══ Warmup multi-endpoint ═══
// Cada 90s pingueamos los endpoints críticos de Odin para mantenerlos warm
// y para mantener vivas las conexiones TLS del keep-alive pool. Sin esto,
// cuando una llamada invoca una función después de un rato, hay 1-3s de
// cold start de Vercel + 400ms de TLS handshake nuevo.
//
// Endpoints pingueados:
// - config-llamada: usado al inicio de cada llamada (memoria del negocio)
// - citas, escalar, aprendizaje: usados durante la llamada (function calls)
const WARMUP_MS = 90 * 1000;
const WARMUP_ENDPOINTS = [
  "/api/voice/config-llamada?negocioId=__warmup__",
  "/api/voice/citas?warmup=1",
  "/api/voice/escalar?warmup=1",
  "/api/voice/aprendizaje?warmup=1",
];
async function warmupOdin() {
  const t0 = Date.now();
  await Promise.all(
    WARMUP_ENDPOINTS.map((path) =>
      fetch(`${config.odinAppUrl}${path}`, { signal: AbortSignal.timeout(8000) })
        .catch((err) => {
          console.warn(`[WARMUP] ${path}:`, err?.message || err);
          return null;
        })
    )
  );
  console.log(`[WARMUP] ${WARMUP_ENDPOINTS.length} endpoints warmed en ${Date.now() - t0}ms`);
}
setInterval(warmupOdin, WARMUP_MS);

// ═══ Iniciar servidor ═══

server.listen(config.port, () => {
  console.log(`
╔════════════════════════════════════════════╗
║           ODIN VOICE SERVER                ║
║                                            ║
║   Puerto:  ${config.port}                         ║
║   WS:      ${config.voiceServerUrl}/ws     ║
║   Estado:  ONLINE                          ║
╚════════════════════════════════════════════╝
  `);
  // Primer warmup a los 30s del arranque
  setTimeout(warmupOdin, 30_000);
});
