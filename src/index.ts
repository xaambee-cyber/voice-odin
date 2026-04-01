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

// Health check
app.get("/", (req, res) => {
  res.json({
    servicio: "odin-voice",
    estado: "online",
    version: "1.0.0",
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

// Map de llamadas activas
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
        const negocioId = mensaje.start?.customParameters?.negocioId || "default";
        const configNegocio = obtenerConfig(negocioId);

        console.log(`[WS] Llamada ${callSid} → negocioId: ${negocioId}`);

        pipeline = new PipelineLlamada(ws, negocioId, configNegocio);
        await pipeline.iniciar();
        llamadasActivas.set(callSid, pipeline);

        // Pasar el mensaje start al pipeline
        pipeline.recibirMensajeTwilio(mensaje);
        return;
      }

      // Todos los demás mensajes van al pipeline
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
});
