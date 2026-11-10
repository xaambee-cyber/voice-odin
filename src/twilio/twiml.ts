import { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import { config, urlPublicaHttps } from "../utils/config";

export function urlMediaStream(): string {
  return `${urlPublicaHttps().replace(/^https:/, "wss:")}/ws`;
}

export function firmaTwilioValida(
  firma: string | string[] | undefined,
  url: string,
  params: Record<string, unknown> = {},
): boolean {
  if (!config.twilioAuthToken || typeof firma !== "string" || !firma) return false;
  try {
    return twilio.validateRequest(config.twilioAuthToken, firma, url, params);
  } catch {
    return false;
  }
}

export function requerirFirmaTwilio(req: Request, res: Response, next: NextFunction) {
  // Traefik termina TLS y conserva el Host público del webhook.
  const host = req.get("host");
  const esPost = req.method === "POST";
  if (!host || (esPost && !req.is("application/x-www-form-urlencoded")) ||
      !firmaTwilioValida(req.get("x-twilio-signature"), `https://${host}${req.originalUrl}`, esPost ? req.body : {})) {
    res.sendStatus(403);
    return;
  }
  next();
}

// Genera el TwiML que abre el stream y pasa los datos de la llamada.
export function handleIncomingCall(req: Request, res: Response) {
  // negocioId puede venir por query (modo legacy) o no venir (lookup por número)
  const negocioId = String(req.query.negocioId || "");

  // Twilio manda el número que llamó (From) y el número Twilio que recibió (To)
  const params = req.method === "POST" ? req.body : req.query;
  const callerNumber = String(params.From || params.Caller || "").replace("+", "");
  const numeroTwilio = String(params.To || params.Called || "");
  // Si la llamada llegó por desvío, Twilio incluye ForwardedFrom con el
  // número que originalmente fue marcado (ej. el número de la terraza/sucursal
  // antes de que rebotara al Twilio). Lo usamos para detectar de qué sucursal
  // viene el cliente y dar contexto al agente.
  const forwardedFrom = String(params.ForwardedFrom || "").replace("+", "");

  // Si el WebSocket falla o se cierra, Twilio ejecuta el <Say> como fallback
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="/twiml-fallback" method="POST">
    <Stream url="${urlMediaStream()}">
      <Parameter name="negocioId" value="${escapeXml(negocioId)}" />
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

function escapeXml(s: string): string {
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
