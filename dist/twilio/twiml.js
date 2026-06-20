"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleIncomingCall = handleIncomingCall;
exports.handleFallback = handleFallback;
const config_1 = require("../utils/config");
// Genera TwiML que le dice a Twilio:
// 1. Conectar el audio bidireccional por WebSocket al voice server
// 2. Pasar como parámetros: el negocioId (si vino en query) y el número Twilio
//    que recibió la llamada (req.body.To). El pipeline usará uno u otro para
//    cargar la config del negocio correcto.
function handleIncomingCall(req, res) {
    // negocioId puede venir por query (modo legacy) o no venir (lookup por número)
    const negocioId = req.query.negocioId || "";
    // Twilio manda el número que llamó (From) y el número Twilio que recibió (To)
    const callerNumber = String(req.body?.From || req.body?.Caller || "").replace("+", "");
    const numeroTwilio = String(req.body?.To || req.body?.Called || "");
    // Si la llamada llegó por desvío, Twilio incluye ForwardedFrom con el
    // número que originalmente fue marcado (ej. el número de la terraza/sucursal
    // antes de que rebotara al Twilio). Lo usamos para detectar de qué sucursal
    // viene el cliente y dar contexto al agente.
    const forwardedFrom = String(req.body?.ForwardedFrom || "").replace("+", "");
    const wsUrl = config_1.config.voiceServerUrl.replace("wss://", "").replace("ws://", "").replace("https://", "").replace("http://", "");
    // Si el WebSocket falla o se cierra, Twilio ejecuta el <Say> como fallback
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="/twiml-fallback" method="POST">
    <Stream url="wss://${wsUrl}/ws">
      <Parameter name="negocioId" value="${negocioId}" />
      <Parameter name="numeroTwilio" value="${escapeXml(numeroTwilio)}" />
      <Parameter name="callerNumber" value="${escapeXml(callerNumber)}" />
      <Parameter name="forwardedFrom" value="${escapeXml(forwardedFrom)}" />
    </Stream>
  </Connect>
  <Say language="es-MX" voice="Polly.Mia">Lo sentimos, hubo un problema con el asistente. Por favor intente de nuevo en unos momentos.</Say>
  <Hangup/>
</Response>`;
    res.type("text/xml");
    res.send(twiml);
    console.log(`[TWILIO] Llamada entrante → numeroTwilio: ${numeroTwilio || "?"}, negocioId(query): ${negocioId || "(ninguno, lookup por número)"}, caller: ${callerNumber || "desconocido"}${forwardedFrom ? `, forwardedFrom: ${forwardedFrom}` : ""}`);
}
// TwiML de fallback cuando el server no está disponible
function handleFallback(req, res) {
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
function escapeXml(s) {
    return s.replace(/[<>&"']/g, (c) => {
        switch (c) {
            case "<": return "&lt;";
            case ">": return "&gt;";
            case "&": return "&amp;";
            case '"': return "&quot;";
            case "'": return "&apos;";
            default: return c;
        }
    });
}
//# sourceMappingURL=twiml.js.map