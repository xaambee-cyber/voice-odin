// ═══════════════════════════════════════════════════════════════════════════
// Piezas PURAS del motor de voz de Telnyx (Conversation Relay). Sin red ni
// estado: se prueban solas en tests/relay.test.ts.
//
// Conversation Relay = Telnyx contesta, transcribe al cliente (Deepgram) y
// habla con SUS voces (Ultra); nosotros recibimos texto por un WebSocket y
// mandamos texto de vuelta. Quien piensa es Claude (src/telnyx/relay.ts).
// ═══════════════════════════════════════════════════════════════════════════

/** Voces de gpt-realtime que acepta el motor de OpenAI. */
export const VOCES_OPENAI = new Set(["marin", "cedar", "alloy", "ash", "ballad", "echo", "sage", "verse"]);

/**
 * ¿Es una voz de Telnyx? ("Telnyx.Ultra.<uuid>", "Telnyx.KokoroTTS.ef_dora"…).
 * Es lo que decide el motor: una línea de Telnyx con voz de Telnyx usa
 * Conversation Relay; con voz de OpenAI, el motor de siempre.
 */
export function esVozTelnyx(voz: unknown): voz is string {
  return typeof voz === "string" && /^Telnyx\.[A-Za-z0-9]+\.[A-Za-z0-9_.\-]{1,80}$/.test(voz);
}

/**
 * La voz que puede usar el motor de OpenAI. Si el dueño eligió una de Telnyx
 * pero la llamada entró por Twilio (o por el motor de OpenAI), se usa Marin: un
 * nombre que OpenAI no conoce tumbaría la sesión y el cliente oiría el aviso de
 * "no disponible".
 */
export function vozParaOpenAI(voz: unknown): string {
  return typeof voz === "string" && VOCES_OPENAI.has(voz) ? voz : "marin";
}

/** Velocidad válida para las voces Ultra (0.6–1.5). null = la de la voz. */
export function velocidadTelnyx(v: unknown): number | null {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n) || n <= 0) return null;
  const acotada = Math.min(1.5, Math.max(0.6, n));
  return Math.abs(acotada - 1) < 0.01 ? null : Number(acotada.toFixed(2));
}

/**
 * Reconocimiento de voz. Default: Deepgram **Flux multilenguaje** en español,
 * que trae su propio detector de fin de turno y avisa ANTES del texto final
 * ("eagerEndOfTurn") — con eso empezamos a pensar la respuesta mientras el
 * cliente termina la frase. Nova-3 queda como plan B por env (VOZ_RELAY_STT).
 */
export function configTranscripcion(modelo = process.env.VOZ_RELAY_STT || "deepgram/flux-multi"): {
  transcription_engine: "Deepgram";
  transcription_engine_config: Record<string, unknown>;
} {
  if (modelo === "deepgram/nova-3") {
    return {
      transcription_engine: "Deepgram",
      transcription_engine_config: {
        transcription_model: "deepgram/nova-3",
        language: "es",
        // Nova-3 cierra el enunciado tras 1 s de silencio por default: es
        // latencia pura que el cliente oye. 600 ms sigue sin cortar a nadie.
        utterance_end_ms: Number(process.env.VOZ_RELAY_FIN_MS) || 600,
      },
    };
  }
  const eot = Math.min(0.9, Math.max(0.5, Number(process.env.VOZ_RELAY_EOT) || 0.7));
  const eager = Math.min(0.7, Math.max(0.3, Number(process.env.VOZ_RELAY_EOT_TEMPRANO) || 0.5));
  return {
    transcription_engine: "Deepgram",
    transcription_engine_config: {
      transcription_model: "deepgram/flux-multi",
      language: "es",
      eot_threshold: eot,
      eager_eot_threshold: Math.min(eager, eot),
    },
  };
}

export type ParametrosRelay = Record<string, string>;

/**
 * El `conversation_relay_config` que va en el `answer` (entrantes) o en el
 * `dial` (llamada de prueba). `custom_parameters` regresa tal cual en el frame
 * `setup` del WebSocket: ahí viajan el número del negocio, quién llama y la
 * sucursal de desvío, igual que el client_state del motor de OpenAI.
 */
export function configRelay(opts: {
  url: string;
  voz: string;
  velocidad?: unknown;
  parametros: ParametrosRelay;
}): Record<string, unknown> {
  const velocidad = velocidadTelnyx(opts.velocidad);
  const stt = configTranscripcion();
  return {
    url: opts.url,
    voice: opts.voz,
    tts_provider: "telnyx",
    ...(velocidad != null ? { voice_settings: { type: "telnyx", voice_speed: velocidad } } : {}),
    language: process.env.VOZ_RELAY_IDIOMA || "es",
    ...stt,
    // Solo la VOZ del cliente corta al agente (un tono del teclado no).
    interruptible: "speech",
    interruptible_greeting: "speech",
    dtmf_detection: true,
    custom_parameters: opts.parametros,
  };
}

// ── Costos (hoja pública de Telnyx, nov-2026) ───────────────────────────────
// Conversation Relay: $0.05/min de plataforma. La voz Ultra se cobra por
// carácter y el reconocimiento por minuto. Telnyx no aclara si Relay ya los
// incluye (el AI Assistant sí); registramos lo CONSERVADOR —todo sumado— hasta
// verlo en una factura real.
export const TARIFA_RELAY_USD = {
  relayPorMinuto: 0.05,
  ttsUltraPorCaracter: 0.000032,
  sttPorMinuto: 0.0074,
} as const;

export function costoRelayUsd(segundos: number, caracteresTts: number): number {
  const minutos = Math.ceil(Math.max(0, segundos) / 60);
  const total =
    minutos * (TARIFA_RELAY_USD.relayPorMinuto + TARIFA_RELAY_USD.sttPorMinuto) +
    Math.max(0, caracteresTts) * TARIFA_RELAY_USD.ttsUltraPorCaracter;
  return Number(total.toFixed(6));
}

// ── Texto que se convierte en voz ───────────────────────────────────────────

/**
 * Limpia lo que el modelo escribe antes de mandarlo al TTS: markdown, emojis y
 * acotaciones entre corchetes se leerían en voz alta ("asterisco asterisco").
 * Se aplica por fragmento, así que no puede depender de ver la frase completa.
 */
export function textoParaVoz(fragmento: string): string {
  return fragmento
    .replace(/[*_#`>|]+/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/‍|️/g, "");
}

/** Normaliza para comparar el texto "temprano" con el final (eager vs final). */
export function normalizarParaComparar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ¿El final dice lo mismo que el temprano? Entonces la respuesta que ya preparamos sirve. */
export function mismoTurno(temprano: string, final: string): boolean {
  const a = normalizarParaComparar(temprano);
  const b = normalizarParaComparar(final);
  return a.length > 0 && a === b;
}

/** Milisegundos aproximados que tarda en decirse un texto (≈14 caracteres por segundo). */
export function msParaDecir(texto: string): number {
  return Math.round((texto.trim().length / 14) * 1000);
}
