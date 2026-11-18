import type { Request, Response } from "express";
import { config, urlPublicaHttps } from "../utils/config";
import { hayTransferencia, tomarTransferencia, type TransferenciaActiva } from "../api/transferencias";
import { motivoRelayNoDisponible, relayDisponible } from "./relay";
import * as telnyx from "./api";
import { verificarFirmaTelnyx, tokenStream, type DatosSaliente } from "./firma";
import { configRelay, esVozTelnyx } from "./relay-config";
import {
  codificarEstado,
  decodificarEstado,
  debeRechazarSinContestar,
  msDe,
  normalizarE164,
  numeroDeDiversion,
  numeroLlamante,
  segundosConHumano,
  type GateLlamada,
} from "./eventos";

// ═══════════════════════════════════════════════════════════════════════════
// POST /telnyx/webhook — el "/twiml" de Telnyx.
//
// Todos los avisos de Call Control de nuestros números de Telnyx llegan aquí
// (la URL se pone una vez en la Call Control Application del portal). Hacemos
// lo mismo que Twilio + nuestro TwiML, en eventos:
//
//   call.initiated (entrante) → ¿agente o línea apagados? rechazar (ocupado,
//                               sin costo). Si no, contestar y abrir el audio
//                               hacia /ws-telnyx con el contexto en client_state.
//   call.answered  (pierna de transferencia) → anotar a qué hora contestó el humano.
//   call.hangup    (pierna de transferencia) → cobrar el tramo humano en Odin
//                               (/api/webhooks/voice-transferencia, igual que
//                               /transferencia-estado de Twilio) y colgar al cliente.
//   call.speak.ended (despedida) → colgar.
//   streaming.failed → el audio no conectó: despedir y colgar (el
//                               /twiml-fallback de Twilio).
//
// Respondemos 200 de inmediato y trabajamos después: Telnyx reintenta si
// tardamos, y un reintento de `call.initiated` contestaría dos veces (lo frena
// el `command_id`, pero mejor no provocarlo).
// ═══════════════════════════════════════════════════════════════════════════

/** Ruta del WebSocket de audio, con el token de esta llamada. */
export function urlStreamTelnyx(callControlId: string): string {
  const base = urlPublicaHttps().replace(/^https:/, "wss:");
  const q = new URLSearchParams({ ccid: callControlId, t: tokenStream(callControlId) });
  return `${base}/ws-telnyx?${q.toString()}`;
}

/** Ruta del WebSocket del motor de Telnyx (Conversation Relay), con el mismo token. */
export function urlRelayTelnyx(callControlId: string): string {
  const base = urlPublicaHttps().replace(/^https:/, "wss:");
  const q = new URLSearchParams({ ccid: callControlId, t: tokenStream(callControlId) });
  return `${base}/relay-telnyx?${q.toString()}`;
}

/** Igual, para una llamada saliente (de prueba): firma número y destino en vez del ccid. */
export function urlSalienteTelnyx(ruta: "ws-telnyx" | "relay-telnyx", firmado: { pr: string; t: string }): string {
  const base = urlPublicaHttps().replace(/^https:/, "wss:");
  return `${base}/${ruta}?${new URLSearchParams(firmado).toString()}`;
}

/** Lo que el pipeline necesita saber de la llamada, en `custom_parameters` del relay. */
export function parametrosRelay(datos: DatosSaliente & { f?: string; prueba?: boolean }): Record<string, string> {
  return {
    n: datos.n,
    c: datos.c,
    f: datos.f || "",
    ...(datos.prueba ? { prueba: "1" } : {}),
  };
}

const DESPEDIDA =
  "Lo sentimos, en este momento no podemos atender su llamada. Por favor intente de nuevo en unos minutos o escríbanos por WhatsApp.";

/** Despide con voz y cuelga al terminar; si Telnyx no puede hablar, cuelga ya. */
export async function despedirYColgar(callControlId: string): Promise<void> {
  const r = await telnyx.hablar(callControlId, DESPEDIDA, codificarEstado({ k: "colgar" }));
  if (!r.ok) {
    console.error(`[TELNYX] No se pudo decir la despedida (${r.error}) — colgando directo`);
    await telnyx.colgar(callControlId);
  }
}

/**
 * Pregunta a Odin, ANTES de contestar, si esta línea debe contestar. Usa el
 * mismo `config-llamada` (que lee la base en ese momento) en su modo ligero.
 * Si Odin no responde a tiempo, devuelve null y se contesta: el pipeline vuelve
 * a preguntar con reintentos y, si sigue sin poder, se despide. Perder una
 * llamada de un cliente por un timeout nuestro sería peor que unos segundos de
 * línea.
 */
async function consultarGate(numero: string, caller: string): Promise<GateLlamada> {
  const params = new URLSearchParams({ numeroTwilio: numero, soloGate: "1" });
  if (caller) params.set("callerNumber", caller);
  try {
    const resp = await fetch(`${config.odinAppUrl}/api/voice/config-llamada?${params.toString()}`, {
      headers: config.voiceServerSecret ? { Authorization: `Bearer ${config.voiceServerSecret}` } : {},
      signal: AbortSignal.timeout(2500),
    });
    if (!resp.ok) return null;
    return (await resp.json().catch(() => null)) as GateLlamada;
  } catch (e) {
    console.warn("[TELNYX] Gate de Odin no respondió a tiempo — se contesta igual:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function atenderEntrante(p: any): Promise<void> {
  const ccid = String(p?.call_control_id || "");
  const numero = normalizarE164(p?.to);
  const caller = numeroLlamante(p?.from);
  const forwardedFrom = numeroDeDiversion(p?.sip_headers);
  console.log(
    `[TELNYX] Llamada entrante → numero: ${numero || "?"}, caller: ${caller || "desconocido"}${forwardedFrom ? `, forwardedFrom: ${forwardedFrom}` : ""}`,
  );

  const gate = await consultarGate(numero, caller);
  if (debeRechazarSinContestar(gate)) {
    const r = await telnyx.rechazar(ccid);
    console.log(`[TELNYX] ${numero}: ${gate?.motivo} → rechazada sin contestar${r.ok ? "" : ` (fallo: ${r.error})`}`);
    return;
  }

  const clientState = codificarEstado({ k: "in", n: numero, c: caller, f: forwardedFrom });

  // Voz de Telnyx elegida en el panel → motor de Telnyx (sus voces premium y su
  // reconocimiento; Claude piensa). Cualquier otra → el motor de OpenAI de
  // siempre. Si Odin no contestó el gate, también el de siempre: es el que
  // sabe arreglárselas sin saber nada de antemano.
  if (esVozTelnyx(gate?.voz) && !relayDisponible()) {
    console.error(`[TELNYX] ${numero} tiene voz premium pero el motor de Telnyx no puede contestar (${motivoRelayNoDisponible()}) — se contesta con OpenAI`);
  }
  if (esVozTelnyx(gate?.voz) && relayDisponible()) {
    const relay = configRelay({
      url: urlRelayTelnyx(ccid),
      voz: gate!.voz!,
      velocidad: gate?.velocidadVoz,
      ajustes: gate?.ajustes,
      parametros: parametrosRelay({ n: numero, c: caller, f: forwardedFrom }),
    });
    const r = await telnyx.contestarConRelay(ccid, { relay, clientState });
    if (r.ok) {
      console.log(`[TELNYX] ${numero}: contestada con el motor de Telnyx (voz ${gate!.voz})`);
      return;
    }
    // Si Telnyx rechaza la configuración del relay (voz que ya no existe, etc.)
    // la llamada NO se pierde: se contesta con el motor de siempre.
    console.error(`[TELNYX] Relay rechazado para ${ccid} (${r.error}) — se contesta con el motor de OpenAI`);
  }

  const r = await telnyx.contestar(ccid, { streamUrl: urlStreamTelnyx(ccid), clientState });
  if (!r.ok) console.error(`[TELNYX] No se pudo contestar ${ccid}: ${r.error}`);
}

// Pierna del humano en una transferencia → cuándo contestó (para medir el tramo).
const humanoContesto = new Map<string, number>();
// Por si una pierna nunca manda hangup: se purga con las transferencias viejas.
const TTL_MS = 6 * 60 * 60 * 1000;
export function purgarContestosViejos(): void {
  const limite = Date.now() - TTL_MS;
  for (const [id, ms] of humanoContesto) if (ms < limite) humanoContesto.delete(id);
}

export type AlTerminarTransferencia = (
  t: TransferenciaActiva,
  duracionSegundos: number,
  estado: string,
) => Promise<void>;

async function procesarEvento(evento: any, alTerminarTransferencia: AlTerminarTransferencia): Promise<void> {
  const tipo = String(evento?.event_type || "");
  const p = evento?.payload || {};
  const ccid = String(p?.call_control_id || "");
  const estado = decodificarEstado(p?.client_state);

  switch (tipo) {
    case "call.initiated": {
      // Las salientes son nuestras (la pierna de una transferencia): no se contestan.
      if (p?.direction === "incoming") await atenderEntrante(p);
      return;
    }
    case "call.answered": {
      if (estado?.k === "tr") {
        humanoContesto.set(ccid, msDe(evento?.occurred_at) ?? Date.now());
        console.log(`[TRANSFER] Humano contestó (pierna ${ccid}) → cliente ${estado.a}`);
      }
      return;
    }
    case "call.hangup": {
      if (estado?.k !== "tr") return; // colgó el cliente: el WebSocket cierra solo y el pipeline cobra.
      const contesto = humanoContesto.get(ccid) ?? null;
      humanoContesto.delete(ccid);
      const segundos = segundosConHumano(contesto, msDe(evento?.occurred_at) ?? Date.now());
      const causa = String(p?.hangup_cause || "");
      // Como en Twilio (<Dial> sin más verbos): al terminar el tramo humano, la
      // llamada del cliente se acaba. Si el humano no contestó, Telnyx deja al
      // cliente en una línea sin audio: colgamos. Si ya colgó, el 422 no importa.
      telnyx.colgar(estado.a).catch(() => {});
      const transferencia = tomarTransferencia(estado.a);
      if (!transferencia) {
        console.warn(`[TRANSFER] Fin de pierna sin transferencia registrada: ${estado.a} — ignorado`);
        return;
      }
      console.log(`[TRANSFER] ${estado.a} → ${transferencia.destino}: ${segundos}s con humano (${causa || "?"})`);
      await alTerminarTransferencia(transferencia, segundos, segundos > 0 ? "completed" : causa || "no-answer");
      return;
    }
    case "call.speak.ended": {
      if (estado?.k === "colgar") await telnyx.colgar(ccid);
      return;
    }
    // Telnyx manda `call.conversation_relay.ended` (la documentación dice
    // `call.conversation.ended`; se aceptan los dos).
    case "call.conversation_relay.ended":
    case "call.conversation.ended": {
      console.log(`[TELNYX] Relay terminado en ${ccid}: ${String(p?.reason || "?")}`);
      // Pasando a un humano: el relay se detuvo a propósito, la llamada sigue.
      if (hayTransferencia(ccid)) return;
      // En cualquier otro caso, una llamada viva sin motor es una llamada MUDA:
      // el cliente oye silencio hasta que cuelga. Se despide y se cuelga. Si la
      // llamada ya terminó (colgó el cliente, colgar_llamada), Telnyx rechaza
      // el `speak` y `despedirYColgar` solo intenta colgar: inofensivo.
      setTimeout(() => {
        despedirYColgar(ccid).catch(() => {});
      }, 300);
      return;
    }
    case "streaming.failed": {
      console.error(`[TELNYX] El audio no conectó para ${ccid}:`, JSON.stringify(p).slice(0, 300));
      await despedirYColgar(ccid);
      return;
    }
    default:
      return;
  }
}

export function crearWebhookTelnyx(alTerminarTransferencia: AlTerminarTransferencia) {
  return function webhookTelnyx(req: Request, res: Response) {
    if (!config.telnyxPublicKey) {
      console.error("[TELNYX] Falta TELNYX_PUBLIC_KEY: se rechaza el aviso (no se puede verificar quién lo manda).");
      res.status(503).json({ error: "no_configurado" });
      return;
    }
    const crudo = (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "";
    const valida = verificarFirmaTelnyx(
      crudo,
      req.get("telnyx-signature-ed25519"),
      req.get("telnyx-timestamp"),
      config.telnyxPublicKey,
    );
    if (!valida) {
      console.error("[TELNYX] Firma inválida en /telnyx/webhook");
      res.status(401).json({ error: "firma_invalida" });
      return;
    }
    res.sendStatus(200);
    const evento = (req.body as { data?: unknown })?.data;
    procesarEvento(evento, alTerminarTransferencia).catch((e) =>
      console.error("[TELNYX] Error procesando aviso:", e instanceof Error ? e.message : e),
    );
  };
}
