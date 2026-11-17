import type { Request, Response } from "express";
import twilio from "twilio";
import { config, urlPublicaHttps } from "../utils/config";
import { twimlLlamadaSaliente } from "../twilio/twiml";
import * as telnyx from "../telnyx/api";
import { firmarSaliente } from "../telnyx/firma";
import { configRelay, esVozTelnyx } from "../telnyx/relay-config";
import { parametrosRelay, urlSalienteTelnyx } from "../telnyx/webhook";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/llamada-prueba  (solo Odin, con VOICE_SERVER_SECRET)
//
// El dueño aprieta "Llamarme para probar" en el panel y su agente le marca.
// Del otro lado corre EXACTAMENTE la misma llamada que con un cliente: misma
// configuración, mismas herramientas, mismo cobro y la conversación entra a
// Odin. La única diferencia es la dirección: aquí la persona que contesta hace
// de "cliente" (su número es el `callerNumber`).
//
// Quién puede recibirla, cuántas por hora y que el negocio tenga línea lo
// decide Odin (`/api/voice/llamada-prueba`). Aquí solo se valida la forma.
// ═══════════════════════════════════════════════════════════════════════════

/** Límite duro de una llamada de prueba: nadie deja una línea abierta por error. */
const LIMITE_SEGUNDOS = 5 * 60;

function e164(n: unknown): string | null {
  const s = String(n ?? "").trim();
  return /^\+[1-9]\d{9,14}$/.test(s) ? s : null;
}

export async function iniciarLlamadaPrueba(req: Request, res: Response) {
  const numero = e164(req.body?.numero);
  const destino = e164(req.body?.destino);
  const proveedor = req.body?.proveedor === "telnyx" ? "telnyx" : "twilio";
  const voz = typeof req.body?.voz === "string" ? req.body.voz : "";
  if (!numero || !destino) {
    return res.status(400).json({ ok: false, error: "numero y destino en formato +52…" });
  }
  if (numero === destino) {
    return res.status(400).json({ ok: false, error: "La línea no puede llamarse a sí misma" });
  }
  // Como Twilio entrega el From: sin "+". Es lo que el pipeline usa como "quién llama".
  const caller = destino.replace("+", "");

  if (proveedor === "telnyx") {
    const connectionId = String(req.body?.connectionId || process.env.TELNYX_VOZ_CONNECTION_ID || "");
    if (!connectionId) return res.status(400).json({ ok: false, error: "Falta la Call Control App de Telnyx" });
    const firmado = firmarSaliente({ n: numero, c: caller });
    const usarRelay = esVozTelnyx(voz);
    const r = await telnyx.marcar({
      connectionId,
      to: destino,
      from: numero,
      timeLimitSecs: LIMITE_SEGUNDOS,
      ...(usarRelay
        ? {
            relay: configRelay({
              url: urlSalienteTelnyx("relay-telnyx", firmado),
              voz,
              velocidad: req.body?.velocidadVoz,
              parametros: parametrosRelay({ n: numero, c: caller, prueba: true }),
            }),
          }
        : { streamUrl: urlSalienteTelnyx("ws-telnyx", firmado) }),
    });
    if (!r.ok) {
      console.error(`[PRUEBA] Telnyx no pudo marcar ${numero} → ${destino}: ${r.error}`);
      return res.status(502).json({ ok: false, error: r.error || "Telnyx no pudo marcar" });
    }
    console.log(`[PRUEBA] Marcando (Telnyx, motor ${usarRelay ? "Telnyx" : "OpenAI"}) ${numero} → ${destino} · ${r.callControlId}`);
    return res.json({ ok: true, llamadaId: r.callControlId || null, motor: usarRelay ? "relay" : "openai" });
  }

  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    return res.status(503).json({ ok: false, error: "Faltan credenciales de Twilio en el voice server" });
  }
  try {
    const cliente = twilio(config.twilioAccountSid, config.twilioAuthToken);
    const llamada = await cliente.calls.create({
      to: destino,
      from: numero,
      twiml: twimlLlamadaSaliente({ numeroTwilio: numero, callerNumber: caller, base: urlPublicaHttps() }),
      timeout: 30,
      timeLimit: LIMITE_SEGUNDOS,
    });
    console.log(`[PRUEBA] Marcando (Twilio) ${numero} → ${destino} · ${llamada.sid}`);
    return res.json({ ok: true, llamadaId: llamada.sid, motor: "openai" });
  } catch (e: any) {
    console.error(`[PRUEBA] Twilio no pudo marcar ${numero} → ${destino}:`, e?.message || e);
    return res.status(502).json({ ok: false, error: e?.message || "Twilio no pudo marcar" });
  }
}
