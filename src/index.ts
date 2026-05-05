import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./utils/config";
import { handleIncomingCall, handleFallback } from "./twilio/twiml";
import { configurarNegocio, obtenerEstado, obtenerConfig, listarNegocios } from "./api/configurar";
import { PipelineLlamada } from "./pipeline/llamada";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// ═══ Warmup periódico de Vercel ═══
// Cada 4 minutos hacemos un ping al endpoint de config para mantener la
// función serverless caliente. Sin esto, una llamada que entra después de
// rato encuentra Vercel frío y el fetch tarda 3-5s extra.
const WARMUP_MS = 4 * 60 * 1000;
async function warmupOdin() {
  try {
    const resp = await fetch(`${config.odinAppUrl}/api/voice/config-llamada?negocioId=__warmup__`, {
      signal: AbortSignal.timeout(8000),
    });
    // Cualquier respuesta (incluido 400 por negocioId inválido) cuenta como warm
    console.log(`[WARMUP] Odin respondió ${resp.status}`);
  } catch (err: any) {
    console.warn("[WARMUP] Odin no respondió:", err?.message || err);
  }
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
