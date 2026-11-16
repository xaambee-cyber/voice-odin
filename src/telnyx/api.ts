import { config } from "../utils/config";

// ═══════════════════════════════════════════════════════════════════════════
// Comandos de Call Control de Telnyx (https://api.telnyx.com/v2/calls/…).
//
// Es el equivalente de `client.calls(sid).update(...)` de Twilio: aquí cada
// acción es su propio endpoint. Nunca lanzan: devuelven { ok, status, error }
// para que el pipeline decida (igual que con Twilio, un fallo al colgar o al
// transferir NO debe tumbar la llamada).
// ═══════════════════════════════════════════════════════════════════════════

const BASE = "https://api.telnyx.com/v2";

export type ResultadoComando = { ok: boolean; status: number; error?: string };

function resumenError(json: unknown): string {
  const errores = (json as { errors?: { code?: string; title?: string; detail?: string }[] })?.errors;
  if (!Array.isArray(errores) || errores.length === 0) return "";
  return errores
    .map((e) => [e.code, e.title, e.detail].filter(Boolean).join(" · "))
    .join(" | ")
    .slice(0, 400);
}

async function comando(
  callControlId: string,
  accion: string,
  cuerpo: Record<string, unknown> = {},
  timeoutMs = 8000,
): Promise<ResultadoComando> {
  if (!config.telnyxApiKey) return { ok: false, status: 0, error: "Falta TELNYX_API_KEY" };
  if (!callControlId) return { ok: false, status: 0, error: "Sin call_control_id" };
  try {
    const r = await fetch(`${BASE}/calls/${encodeURIComponent(callControlId)}/actions/${accion}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.telnyxApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) return { ok: true, status: r.status };
    const json = await r.json().catch(() => null);
    return { ok: false, status: r.status, error: resumenError(json) || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Contesta y abre el audio bidireccional hacia /ws-telnyx.
 *  - `stream_codec: PCMU` fuerza μ-law 8 kHz en lo que RECIBIMOS (si no, Telnyx
 *    manda el códec de la llamada, que puede ser G.722 o PCMA) — OpenAI está
 *    configurado en `audio/pcmu`, igual que con Twilio.
 *  - `stream_bidirectional_mode: rtp` + `PCMU`: lo que MANDAMOS son los mismos
 *    bytes μ-law que OpenAI entrega, sin convertir. Los sonidos pregenerados
 *    (tecleo, ambiente) también son μ-law y sirven tal cual.
 *  - `stream_track: inbound_track`: solo la voz del cliente, como Twilio.
 */
export function contestar(
  callControlId: string,
  opts: { streamUrl: string; clientState: string },
): Promise<ResultadoComando> {
  return comando(callControlId, "answer", {
    stream_url: opts.streamUrl,
    stream_track: "inbound_track",
    stream_codec: "PCMU",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
    client_state: opts.clientState,
    command_id: `answer-${callControlId}`,
  });
}

/** Rechaza SIN contestar: el cliente oye ocupado y no se cobra la llamada. */
export function rechazar(callControlId: string): Promise<ResultadoComando> {
  return comando(callControlId, "reject", { cause: "USER_BUSY", command_id: `reject-${callControlId}` });
}

export function colgar(callControlId: string): Promise<ResultadoComando> {
  return comando(callControlId, "hangup", { command_id: `hangup-${callControlId}` });
}

/**
 * Habla con la voz Polly.Mia (la misma del <Say> de Twilio) — solo para la
 * despedida cuando el agente no está disponible. `clientState` permite colgar
 * al terminar (`call.speak.ended`).
 */
export function hablar(callControlId: string, texto: string, clientState: string): Promise<ResultadoComando> {
  return comando(callControlId, "speak", {
    payload: texto,
    payload_type: "text",
    voice: "Polly.Mia",
    language: "es-MX",
    client_state: clientState,
    command_id: `speak-${callControlId}`,
  });
}

/**
 * Pasa la llamada a un humano: Telnyx marca a `to` y, cuando contesta, lo une
 * con el cliente (que mientras oye el timbre: `early_media`). Es el <Dial
 * answerOnBridge> de Twilio. `from` debe ser nuestro número de Telnyx —el
 * equivalente del callerId— y `targetLegClientState` marca la pierna nueva
 * para medir cuánto habló el humano (se cobra aparte, como en Twilio).
 */
export function transferir(
  callControlId: string,
  opts: { to: string; from: string; timeoutSecs: number; targetLegClientState: string },
): Promise<ResultadoComando> {
  return comando(callControlId, "transfer", {
    to: opts.to,
    from: opts.from,
    timeout_secs: opts.timeoutSecs,
    early_media: true,
    target_leg_client_state: opts.targetLegClientState,
    command_id: `transfer-${callControlId}`,
  });
}

/** Cierra el audio hacia el agente (Telnyx manda "stop" al WebSocket). */
export function detenerStream(callControlId: string): Promise<ResultadoComando> {
  return comando(callControlId, "streaming_stop", { command_id: `streaming-stop-${callControlId}` });
}
