import { Request, Response } from "express";
import { config } from "../utils/config";

// Genera TwiML que le dice a Twilio:
// 1. Conectar el audio bidireccional por WebSocket
// 2. El WebSocket va al voice server en el VPS
export function handleIncomingCall(req: Request, res: Response) {
  const negocioId = req.query.negocioId as string || "default";
  const callerNumber = ((req.body?.From || req.body?.Caller || "") as string).replace("+", "");
  const wsUrl = config.voiceServerUrl.replace("wss://", "").replace("ws://", "");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${wsUrl}/ws">
      <Parameter name="negocioId" value="${negocioId}" />
      <Parameter name="callerNumber" value="${callerNumber}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);

  console.log(`[TWILIO] Llamada entrante → negocioId: ${negocioId}, caller: ${callerNumber || "desconocido"}`);
}

// TwiML de fallback cuando el server no está disponible
export function handleFallback(req: Request, res: Response) {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-MX" voice="Polly.Mia">
    Lo sentimos, nuestro asistente no está disponible en este momento. 
    Por favor, intente llamar más tarde o envíenos un mensaje por WhatsApp.
  </Say>
  <Hangup/>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
}
