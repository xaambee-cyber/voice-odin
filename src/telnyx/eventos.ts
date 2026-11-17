// ═══════════════════════════════════════════════════════════════════════════
// Piezas PURAS del canal Telnyx (sin red, sin estado): se prueban solas en
// tests/telnyx.test.ts.
//
// Telnyx no habla TwiML aquí: usamos su Call Control (la API nativa). Cada
// llamada manda avisos JSON firmados a /telnyx/webhook y nosotros respondemos
// con comandos (answer, hangup, transfer...). Lo que Twilio nos daba como
// parámetros del <Stream> (número, quién llama, desde qué sucursal se desvió)
// viaja aquí dentro de `client_state`: un base64 que Telnyx nos devuelve en
// cada aviso siguiente y en el mensaje "start" del WebSocket.
// ═══════════════════════════════════════════════════════════════════════════

/** Lo que guardamos en `client_state`. Claves cortas: Telnyx limita el tamaño. */
export type EstadoTelnyx =
  /** Llamada entrante contestada por la IA. */
  | { k: "in"; n: string; c: string; f: string }
  /** Pierna saliente de una transferencia a humano. `a` = call_control_id del cliente. */
  | { k: "tr"; a: string; nid: string }
  /** Despedida: al terminar de hablar, colgar. */
  | { k: "colgar" };

export function codificarEstado(estado: EstadoTelnyx): string {
  return Buffer.from(JSON.stringify(estado), "utf8").toString("base64");
}

export function decodificarEstado(b64: unknown): EstadoTelnyx | null {
  if (typeof b64 !== "string" || !b64) return null;
  try {
    const obj = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (obj && typeof obj === "object" && typeof obj.k === "string") return obj as EstadoTelnyx;
  } catch {
    // client_state ajeno (otro sistema) o corrupto: se ignora.
  }
  return null;
}

/**
 * El número en E.164 con "+", que es como Odin lo guarda en
 * `config_voz.numero_twilio` (y con lo que `config-llamada` busca el negocio).
 * Telnyx ya manda "+52…", pero si llegara sin "+" la búsqueda fallaría en
 * silencio y la llamada se despediría como "no disponible".
 */
export function normalizarE164(numero: unknown): string {
  const s = String(numero ?? "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return s;
  const digitos = s.replace(/\D/g, "");
  return digitos.length >= 10 && digitos === s ? `+${digitos}` : s;
}

/** Quién llama, sin "+", igual que el `From.replace("+","")` del lado Twilio. */
export function numeroLlamante(from: unknown): string {
  return String(from ?? "").trim().replace("+", "");
}

type CabeceraSip = { name?: unknown; value?: unknown };

/**
 * El equivalente del `ForwardedFrom` de Twilio. Cuando el dueño activa el
 * desvío (`**61*…`), Telcel/AT&T/Movistar mandan la llamada con una cabecera
 * SIP `Diversion` que trae el número que el cliente marcó originalmente, p.ej.
 *   <sip:+524611234567@10.0.0.1;user=phone>;reason=no-answer;counter=1
 *   <tel:+524611234567>;reason=unconditional
 * Telnyx la entrega en `payload.sip_headers` de `call.initiated`. Devolvemos los
 * dígitos SIN "+" (como Twilio entregaba ForwardedFrom ya limpio), o "" si no
 * vino desviada.
 */
export function numeroDeDiversion(sipHeaders: unknown): string {
  if (!Array.isArray(sipHeaders)) return "";
  const cab = (sipHeaders as CabeceraSip[]).find(
    (h) => typeof h?.name === "string" && h.name.toLowerCase() === "diversion",
  );
  if (!cab || typeof cab.value !== "string") return "";
  // Si hubo desvíos encadenados vienen varias, y la PRIMERA es quien desvió más
  // recientemente (RFC 5806). Es la misma semántica que el ForwardedFrom de
  // Twilio ("el número de quien desvió"), y la que necesita el anti-rebote: el
  // humano que no contestó es quien nos regresa la llamada.
  const primera = cab.value.split(/,(?=\s*<)/)[0] ?? "";
  const m = primera.match(/(?:sip|sips|tel):\+?([0-9]{7,15})/i);
  return m ? m[1] : "";
}

/**
 * Tarifa de Telnyx para México (hoja pública, nov-2026), en USD por minuto:
 * entrada a número local + cargo de Voice API + audio en vivo al agente.
 * Se redondea al minuto por llamada, igual que el cálculo de Twilio, para que
 * el costo registrado sea conservador mientras no confirmemos el redondeo real.
 */
export const TARIFA_TELNYX_MX_USD = {
  entradaLocal: 0.005,
  entradaMovil: 0.009,
  voiceApi: 0.002,
  streaming: 0.0035,
} as const;

export function costoTelefoniaTelnyxUsd(
  segundos: number,
  tipo: "local" | "movil" = "local",
  /** false con el motor de Telnyx (Conversation Relay): no hay stream de audio nuestro. */
  conStreaming = true,
): number {
  const minutos = Math.ceil(Math.max(0, segundos) / 60);
  const entrada = tipo === "movil" ? TARIFA_TELNYX_MX_USD.entradaMovil : TARIFA_TELNYX_MX_USD.entradaLocal;
  const porMinuto = entrada + TARIFA_TELNYX_MX_USD.voiceApi + (conStreaming ? TARIFA_TELNYX_MX_USD.streaming : 0);
  return Number((minutos * porMinuto).toFixed(6));
}

/**
 * Lo que responde `config-llamada?soloGate=1` y qué hacemos ANTES de contestar.
 * Twilio lograba "cero consumo" cambiando el webhook del número a un <Reject/>
 * cuando el agente estaba apagado. Con Telnyx el número no se reconfigura:
 * preguntamos a Odin en `call.initiated` y, si el agente o la línea están
 * apagados, rechazamos SIN contestar (ocupado, sin costo). Sin saldo sí se
 * contesta, para decirle al cliente que no podemos atenderlo — igual que Twilio.
 */
export type GateLlamada = {
  bloqueado?: boolean;
  motivo?: string;
  /** Voz elegida en el panel. Si es de Telnyx ("Telnyx.Ultra.…"), se contesta con su motor. */
  voz?: string;
  velocidadVoz?: number | null;
} | null;

export function debeRechazarSinContestar(gate: GateLlamada): boolean {
  if (!gate?.bloqueado) return false;
  return gate.motivo === "agente_apagado" || gate.motivo === "linea_apagada";
}

/** Milisegundos de una fecha ISO de Telnyx, o null. */
export function msDe(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Segundos que habló el humano: desde que contestó hasta que colgó. */
export function segundosConHumano(contestoMs: number | null, colgoMs: number | null): number {
  if (contestoMs == null || colgoMs == null || colgoMs <= contestoMs) return 0;
  return Math.round((colgoMs - contestoMs) / 1000);
}
