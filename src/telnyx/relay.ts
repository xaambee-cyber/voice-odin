import Anthropic from "@anthropic-ai/sdk";
import WebSocket from "ws";
import { config } from "../utils/config";
import { FUNCIONES_CON_ESPERA, fraseEspera, type HerramientaVoz } from "../openai/realtime";
import {
  anotacionHorariaParaAgente,
  normalizarArgumentosConHora,
  ultimaHoraExplicita,
  type HoraExplicita,
} from "../utils/normalizar-hora";
import { mediana, type MotorVoz, type ResumenLatencia, type UsoMotor } from "../voz/motor";
import { configTranscripcion, mismoTurno, msParaDecir, normalizarAjustesRelay, textoParaVoz, type AjustesRelay } from "./relay-config";

// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE VOZ DE TELNYX (Conversation Relay + Claude)
//
// Telnyx contesta, transcribe al cliente y habla con sus voces premium. Por el
// WebSocket nos llega TEXTO (lo que dijo el cliente) y mandamos TEXTO (lo que
// el agente contesta, en fragmentos conforme Claude los escribe, para que la
// voz arranque con la primera palabra y no al final de la respuesta).
//
// Mismo contrato que OpenAIRealtime (MotorVoz): las herramientas las ejecuta el
// pipeline con manejarFuncion, así que agendar, cancelar, transferir, cobrar,
// motores, ubicación… son EXACTAMENTE las mismas que en el motor de siempre.
//
// LATENCIA — lo que más importa aquí:
//   1. Flux (el reconocimiento por default) avisa "probablemente ya terminó"
//      ANTES del texto final (eagerEndOfTurn). En ese momento ya le pedimos la
//      respuesta a Claude, guardando lo que escriba sin mandarlo. Si el texto
//      final coincide, se suelta de golpe: la respuesta sale casi sin espera.
//      Si el cliente siguió hablando (turnResumed) o dijo otra cosa, se tira.
//   2. Cada fragmento de texto sale en cuanto llega (la voz no espera la frase).
//   3. El prompt va con caché: tools + reglas del negocio se leen del caché en
//      cada turno (más rápido y ~10× más barato).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Modelo que piensa. Haiku 5.5 por la meta de ~1 s por turno: es el de menor
 * tiempo al primer token y en una llamada cada décima de segundo se oye.
 * Para probar otro sin tocar código: VOZ_RELAY_MODELO=claude-sonnet-5-5.
 */
export const MODELO_RELAY = process.env.VOZ_RELAY_MODELO || "claude-haiku-5-5";

/** Cerebro "más listo" del panel: mejor razonamiento, ~+0.3–0.5 s por turno. */
export const MODELO_RELAY_LISTO = process.env.VOZ_RELAY_MODELO_LISTO || "claude-sonnet-5-5";

// ── ¿Puede contestar el motor de Telnyx? ────────────────────────────────────
// El 17-nov-2026 las primeras llamadas con voz premium se quedaron MUDAS: el
// motor arrancaba y se apagaba al segundo porque Claude no podía pensar (llave
// faltante o inválida en el voice server). El motor de OpenAI nunca la había
// necesitado, así que nadie lo notó hasta que la línea contestó en silencio.
// Ahora: sin llave, o con Claude fallando por llave/crédito, las llamadas
// contestan con el motor de OpenAI (voz clásica) durante 10 min y se reintenta.
// Peor que una voz menos bonita es una llamada en silencio.
let relayCaidoHasta = 0;
let motivoRelayCaido = "";
const PAUSA_RELAY_CAIDO_MS = 10 * 60_000;

export function relayDisponible(ahora = Date.now()): boolean {
  return !!config.anthropicApiKey && ahora >= relayCaidoHasta;
}

export function motivoRelayNoDisponible(): string {
  if (!config.anthropicApiKey) return "falta ANTHROPIC_API_KEY en el voice server";
  return motivoRelayCaido;
}

/** Claude no puede pensar (llave/crédito): las siguientes llamadas van por OpenAI un rato. */
export function marcarRelayCaido(motivo: string, ahora = Date.now()): void {
  relayCaidoHasta = ahora + PAUSA_RELAY_CAIDO_MS;
  motivoRelayCaido = motivo.slice(0, 200);
  console.error(`[RELAY] Motor de Telnyx en pausa 10 min (se usará OpenAI): ${motivoRelayCaido}`);
}

/** Solo pruebas. */
export function _reiniciarRelayCaido(): void {
  relayCaidoHasta = 0;
  motivoRelayCaido = "";
}

/** USD por 1M de tokens (hoja de Anthropic, nov-2026). */
const PRECIOS_CLAUDE: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function costoClaudeUsd(
  modelo: string,
  uso: { entrada: number; salida: number; cacheLeido: number; cacheEscrito: number },
): number {
  const p = PRECIOS_CLAUDE[modelo] ?? PRECIOS_CLAUDE["claude-sonnet-4-6"]; // desconocido → conservador
  const total =
    uso.entrada * p.in + uso.salida * p.out + uso.cacheLeido * p.cacheRead + uso.cacheEscrito * p.cacheWrite;
  return Number((total / 1_000_000).toFixed(6));
}

/**
 * Parámetros de razonamiento por modelo. En una llamada no hay tiempo para
 * "pensar" antes de hablar: se apaga donde se puede y el esfuerzo va bajo
 * (respuestas cortas, menos preámbulo). Cada familia lo acepta distinto:
 *  - Haiku 5.5: `disabled` se acepta con esfuerzo high o menor.
 *  - Sonnet 5.5: `disabled` da 400; lo equivalente es `between_tools`.
 *  - Opus 5.5: no se puede apagar; solo se baja el esfuerzo.
 *  - Haiku 4.5 / Sonnet 4.6: sin `thinking` no piensa; no aceptan `effort`… salvo Sonnet 4.6.
 */
export function parametrosRazonamiento(
  modelo: string,
  // VOZ_RELAY_PENSAR=1: razonamiento oculto (adaptive). Medido el 16-nov-2026:
  // respuestas más pulidas pero ~+400 ms por turno (≈1.0 s vs ≈0.4–0.6 s al
  // primer texto). Con el prompt real (trae calendario) no hizo falta.
  pensar = process.env.VOZ_RELAY_PENSAR === "1",
): Record<string, unknown> {
  if (pensar) {
    // Los 5.x piensan solos si no se dice nada; Sonnet 4.6 hay que pedírselo.
    if (modelo.startsWith("claude-sonnet-4-6")) return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
    if (/^claude-(haiku|sonnet|opus)-5/.test(modelo)) return { output_config: { effort: "low" } };
    return {};
  }
  if (modelo.startsWith("claude-haiku-5")) return { thinking: { type: "disabled" }, output_config: { effort: "low" } };
  if (modelo.startsWith("claude-sonnet-5-5")) return { thinking: { type: "between_tools" }, output_config: { effort: "low" } };
  if (modelo.startsWith("claude-opus-5")) return { output_config: { effort: "low" } };
  if (modelo.startsWith("claude-sonnet-4-6")) return { output_config: { effort: "low" } };
  return {};
}

/** Las herramientas del motor de OpenAI, en el formato de Claude (mismo esquema JSON). */
export function herramientasClaude(tools: HerramientaVoz[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.parameters && typeof t.parameters === "object"
      ? t.parameters
      : { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));
}

const MARCA_CONTEXTO = "\n=== CONTEXTO DE ESTA LLAMADA ===";

/** Reglas propias de este motor: aquí el agente ESCRIBE y una voz lo lee tal cual. */
const REGLAS_TEXTO_A_VOZ = `
=== TU TEXTO SE CONVIERTE EN VOZ ===
Escribes texto y una voz lo dice tal cual por teléfono.
- Escribe solo lo que dirías en voz alta: sin markdown, emojis, viñetas, acotaciones ni texto entre corchetes.
- Piensa en silencio. NUNCA digas tus cálculos ni deducciones ("hoy es lunes, así que mañana es…") ni fechas en formato técnico (2026-11-18): el cliente solo oye la respuesta.
- No menciones la fecha ni la hora de hoy salvo que te las pregunten: contesta directo a lo que preguntó.
  Ejemplo — cliente: "¿a qué hora abren mañana?" → tú: "Mañana abrimos a las nueve de la mañana. ¿Te aparto un horario?" (NO: "Hoy es lunes, así que mañana es martes…").
- Una o dos frases por turno (máximo unas 35 palabras). Si necesitas un dato, termina con la pregunta.
- Horas y fechas como se dicen: "a las cuatro de la tarde", "el jueves veinte de noviembre". Precios: "trescientos cincuenta pesos".
- Antes de usar una herramienta di, a lo mucho, algo muy corto ("déjame ver") y llámala; nunca prometas un resultado antes de tenerlo.
- Lo que va entre corchetes en los mensajes del cliente son notas del sistema, no palabras suyas: úsalas pero nunca las leas ni las menciones.
- La transcripción del teléfono puede venir con errores: si algo no tiene sentido, pide que lo repita con naturalidad.`;

/**
 * El prompt del negocio partido en dos bloques para el caché: lo estable
 * (reglas, catálogo, horarios) y el contexto de ESTA llamada (fecha, citas de
 * quien llama). El primero se reutiliza entre llamadas del mismo negocio.
 * Las reglas de voz van AL FINAL, después del contexto: es lo último que lee el
 * modelo antes de hablar y donde más pesan (son cortas; no importa que no se
 * reutilicen entre llamadas).
 */
/** Regla de idioma según el ajuste del panel (las instrucciones siguen en español). */
export function reglaIdioma(idioma: AjustesRelay["idioma"]): string {
  if (idioma === "en") return "\n- IDIOMA: habla SIEMPRE en inglés con el cliente, aunque estas instrucciones estén en español.";
  if (idioma === "auto") return "\n- IDIOMA: contesta en el idioma en que te hable el cliente (español o inglés) y no lo cambies sin motivo.";
  return "";
}

export function bloquesSistema(prompt: string, idioma: AjustesRelay["idioma"] = "es"): Anthropic.TextBlockParam[] {
  const i = prompt.indexOf(MARCA_CONTEXTO);
  const estable = i >= 0 ? prompt.slice(0, i) : prompt;
  const volatil = `${i >= 0 ? prompt.slice(i).trim() : ""}\n${REGLAS_TEXTO_A_VOZ}${reglaIdioma(idioma)}`.trim();
  return [
    { type: "text", text: estable, cache_control: { type: "ephemeral" } },
    { type: "text", text: volatil, cache_control: { type: "ephemeral" } },
  ];
}

const ESTILOS_SALUDO = [
  "con energía cálida, como si te alegrara la llamada",
  "sonriendo (que se note amable)",
  "tranquila y profesional",
  "con tono servicial y ágil",
];

/** Un turno del cliente (o uno interno: el saludo, un tecleo). */
interface Turno {
  id: number;
  texto: string;
  /** Nota interna: no es algo que dijo el cliente (no va a su transcripción). */
  interno: boolean;
  /** Arrancó con el aviso temprano de Flux: lo que se escribe se guarda hasta confirmar. */
  especulativo: boolean;
  confirmado: boolean;
  usuarioComprometido: boolean;
  confirmacion: Promise<boolean>;
  resolverConfirmacion: (ok: boolean) => void;
  buffer: string;
  abort: AbortController;
  stream: ReturnType<Anthropic["messages"]["stream"]> | null;
  /** Desde cuándo el cliente espera (texto final, o confirmación del temprano). */
  esperaDesdeMs: number;
  streamDesdeMs: number | null;
  primerTextoMs: number | null;
  /** Texto de la vuelta en curso ya entregado a la voz. */
  textoEnviado: string;
  textoAbierto: boolean;
  interrumpido: boolean;
}

export class MotorRelayTelnyx implements MotorVoz {
  private ws: WebSocket;
  private cliente: Anthropic | null = null;
  private sistema: Anthropic.TextBlockParam[] = [];
  private herramientas: Anthropic.Tool[] = [];
  private mensajes: Anthropic.MessageParam[] = [];
  private cadena: Promise<void> = Promise.resolve();
  private contador = 0;
  private turnoVivo: Turno | null = null;
  private cerrado = false;
  private saludoPedido = false;
  /** Ajustes del panel para ESTA llamada (cerebro, pensar, idioma, reconocimiento). */
  private modelo = MODELO_RELAY;
  private pensar = process.env.VOZ_RELAY_PENSAR === "1";
  private ajustes: AjustesRelay = normalizarAjustesRelay(null);
  private errores = 0;
  private colgarPedido = false;
  /** Telnyx acepta `token: ""` para cerrar el turno; si algún día no, se manda " ". */
  private tokenVacioOk = true;
  /** Cuándo termina (aprox.) de hablar la voz lo que ya le mandamos. */
  private finHablaMs = 0;
  private horaExplicita: { hora: HoraExplicita; detectadaEl: number } | null = null;
  private teclas = "";
  private teclasTimer: ReturnType<typeof setTimeout> | null = null;

  private uso = { entrada: 0, salida: 0, cacheLeido: 0, cacheEscrito: 0, caracteres: 0 };
  private latencias: { totalMs: number; esperaMs: number; modeloMs: number; temprano: boolean }[] = [];
  private aprovechados = 0;
  private descartados = 0;

  private onTranscript: ((texto: string, role: "user" | "assistant", itemId?: string) => void) | null = null;
  private onItemCreated: ((itemId: string) => void) | null = null;
  private onInterrupcion: (() => void) | null = null;
  private onFunctionCall: ((name: string, args: any, callId: string) => Promise<any>) | null = null;
  private onCaida: ((motivo: string) => void) | null = null;
  private onErrorModelo: ((detalle: string) => void) | null = null;

  /** `cliente` solo se inyecta en pruebas (un Claude falso que no cuesta). */
  constructor(ws: WebSocket, opciones: { cliente?: Anthropic } = {}) {
    this.ws = ws;
    if (opciones.cliente) this.cliente = opciones.cliente;
  }

  // ── MotorVoz ─────────────────────────────────────────────────────────────

  setOnAudioDelta(): void { /* Telnyx genera el audio: aquí no pasa audio. */ }
  setOnEspera(): void { /* La espera la cubre la frase hablada; no hay tecleo por este canal. */ }
  setOnTranscript(cb: (texto: string, role: "user" | "assistant", itemId?: string) => void) { this.onTranscript = cb; }
  setOnItemCreated(cb: (itemId: string) => void) { this.onItemCreated = cb; }
  setOnInterrupcion(cb: () => void) { this.onInterrupcion = cb; }
  setOnFunctionCall(cb: (name: string, args: any, callId: string) => Promise<any>) { this.onFunctionCall = cb; }
  setOnCaida(cb: (motivo: string) => void) { this.onCaida = cb; }
  setOnErrorOpenAI(cb: (detalle: string) => void) { this.onErrorModelo = cb; }

  async abrirConexion(): Promise<void> {
    if (this.cliente) return;
    if (!config.anthropicApiKey) throw new Error("Falta ANTHROPIC_API_KEY en el voice server");
    // Reintenta una vez (429/5xx) y corta a los 15 s: en una llamada, esperar
    // más que eso es peor que decir "¿me repites?".
    this.cliente = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 1, timeout: 15_000 });
  }

  configurarSesion(prompt: string, tools: HerramientaVoz[] = []): void {
    this.sistema = bloquesSistema(prompt, this.ajustes.idioma);
    this.herramientas = herramientasClaude(tools);
    if (this.saludoPedido) return;
    this.saludoPedido = true;
    const estilo = ESTILOS_SALUDO[Math.floor(Math.random() * ESTILOS_SALUDO.length)];
    this.iniciarTurno(
      `[La llamada acaba de conectarse. Saluda al cliente ${this.ajustes.idioma === "en" ? "en inglés" : "en español mexicano"}, ${estilo}. Si tus instrucciones traen un SALUDO INICIAL, transmítelo con tus palabras; si no, algo breve tipo "Hola, ¿en qué te puedo ayudar?". UNA sola oración corta y natural.]`,
      { interno: true },
    );
    console.log(
      `[RELAY] Sesión lista — modelo ${this.modelo}${this.pensar ? " (pensando)" : ""}, ${tools.length} herramientas, ` +
        `STT ${this.etiquetaStt()}, idioma ${this.ajustes.idioma}`,
    );
  }

  enviarAudio(): void { /* El audio lo maneja Telnyx. */ }

  cancelarRespuesta(): void {
    const t = this.turnoVivo;
    if (t) this.abortar(t);
  }

  cerrar(): void {
    if (this.cerrado) return;
    this.cerrado = true;
    if (this.teclasTimer) clearTimeout(this.teclasTimer);
    if (this.turnoVivo) this.abortar(this.turnoVivo);
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ motivo: "fin" }) }));
        this.ws.close();
      }
    } catch { /* ya cerrado */ }
  }

  resumenUso(): UsoMotor {
    return {
      audioIn: 0,
      textIn: this.uso.entrada,
      cachedAudioIn: 0,
      cachedTextIn: this.uso.cacheLeido,
      audioOut: 0,
      textOut: this.uso.salida,
      cacheWrite: this.uso.cacheEscrito,
      caracteresTts: this.uso.caracteres,
      modelo: this.modelo,
      costoUsd: costoClaudeUsd(this.modelo, this.uso),
      huboContacto: this.uso.caracteres > 0,
    };
  }

  resumenLatencia(): ResumenLatencia {
    const total = this.latencias.map((l) => l.totalMs);
    if (this.latencias.length > 0) {
      console.log(`[RELAY] Respuestas anticipadas aprovechadas: ${this.aprovechados} · descartadas: ${this.descartados}`);
    }
    return {
      turnos: this.latencias.length,
      medianaMs: mediana(total),
      promedioMs: total.length ? Math.round(total.reduce((a, b) => a + b, 0) / total.length) : null,
      maximaMs: total.length ? Math.max(...total) : null,
      esperaMedianaMs: mediana(this.latencias.map((l) => l.esperaMs)),
      modeloMedianaMs: mediana(this.latencias.map((l) => l.modeloMs)),
      modeloTranscripcion: `telnyx/${this.etiquetaStt()}+${this.modelo}`,
    };
  }

  // ── Extras del relay (los usa el pipeline) ───────────────────────────────

  /**
   * Ajustes del panel (Empleado → "Ajustes de la voz") para esta llamada. Lo
   * llama el pipeline con la config de Odin ANTES de configurarSesion. Lo que
   * toca a Telnyx (voz, velocidad, reconocimiento, interrupciones) ya se fijó
   * al contestar; aquí va lo que decide el que piensa.
   */
  aplicarAjustes(raw: unknown): void {
    this.ajustes = normalizarAjustesRelay(raw);
    this.modelo = this.ajustes.cerebro === "listo" ? MODELO_RELAY_LISTO : MODELO_RELAY;
    this.pensar = this.ajustes.pensar;
  }

  private etiquetaStt(): string {
    return String(configTranscripcion(this.ajustes).transcription_engine_config.transcription_model);
  }

  /** Cuánto le falta (aprox.) a la voz para terminar lo que ya se le mandó. */
  msHablaPendiente(): number {
    return Math.max(0, this.finHablaMs - Date.now());
  }

  /** Decir un texto fijo (despedida) fuera de la conversación del modelo. */
  decir(texto: string): void {
    this.enviarTexto(null, texto, true);
  }

  /** El modelo pidió colgar: no se encadena otra respuesta después. */
  marcarColgado(): void {
    this.colgarPedido = true;
  }

  /** Un frame del WebSocket de Telnyx (el `setup` ya lo consumió index.ts). */
  recibirFrame(msg: any): void {
    if (this.cerrado || !msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "prompt":
        if (msg.last === false) return; // parcial: esperamos el final
        this.alTextoFinal(String(msg.voicePrompt || ""));
        return;
      case "eagerEndOfTurn":
        this.alFinTemprano(String(msg.voicePrompt || ""));
        return;
      case "turnResumed":
        this.alReanudar();
        return;
      case "interrupt":
        this.alInterrumpir(String(msg.utteranceUntilInterrupt || ""));
        return;
      case "dtmf":
        this.alTecla(String(msg.digit || ""));
        return;
      case "error":
        console.error("[RELAY] Telnyx reportó error:", String(msg.description || JSON.stringify(msg)).slice(0, 300));
        if (/token/i.test(String(msg.description || "")) && this.tokenVacioOk) {
          this.tokenVacioOk = false;
          console.warn("[RELAY] Telnyx no acepta token vacío para cerrar turnos — se usará un espacio");
        }
        return;
      default:
        return;
    }
  }

  // ── Turnos del cliente ───────────────────────────────────────────────────

  private alFinTemprano(texto: string) {
    if (!texto.trim() || this.colgarPedido) return;
    const vivo = this.turnoVivo;
    if (vivo?.especulativo && !vivo.confirmado) {
      if (mismoTurno(vivo.texto, texto)) return; // mismo aviso repetido
      this.descartar(vivo);
    }
    this.iniciarTurno(texto, { especulativo: true });
  }

  private alReanudar() {
    const vivo = this.turnoVivo;
    if (vivo?.especulativo && !vivo.confirmado) this.descartar(vivo);
  }

  private alTextoFinal(texto: string) {
    // Tras pedir colgar, un "gracias" del cliente no debe abrir otra respuesta.
    if (!texto.trim() || this.colgarPedido) return;
    const vivo = this.turnoVivo;
    if (vivo?.especulativo && !vivo.confirmado) {
      if (mismoTurno(vivo.texto, texto)) {
        this.confirmar(vivo, texto);
        return;
      }
      this.descartar(vivo);
    }
    this.iniciarTurno(texto, {});
  }

  private alInterrumpir(dicho: string) {
    this.onInterrupcion?.();
    this.finHablaMs = Date.now();
    const vivo = this.turnoVivo;
    if (vivo && !vivo.especulativo && vivo.stream) {
      // Telnyx ya calló la voz: no tiene caso seguir escribiendo encima del cliente.
      vivo.interrumpido = true;
      if (dicho.trim()) vivo.textoEnviado = dicho.trim();
      this.abortar(vivo);
      return;
    }
    // La respuesta ya había terminado de escribirse, pero no de decirse: el
    // historial se queda con lo que el cliente alcanzó a oír.
    if (dicho.trim()) this.recortarUltimaRespuesta(dicho.trim());
  }

  private alTecla(digito: string) {
    if (!/^[0-9*#A-D]$/.test(digito)) return;
    this.teclas += digito;
    if (this.teclasTimer) clearTimeout(this.teclasTimer);
    this.teclasTimer = setTimeout(() => {
      const marcado = this.teclas;
      this.teclas = "";
      this.teclasTimer = null;
      if (marcado) this.iniciarTurno(`[El cliente marcó en el teclado: ${marcado}]`, {});
    }, 1200);
  }

  private iniciarTurno(texto: string, opts: { interno?: boolean; especulativo?: boolean }) {
    const anterior = this.turnoVivo;
    if (anterior) this.abortar(anterior);
    let resolver: (ok: boolean) => void = () => {};
    const confirmacion = new Promise<boolean>((r) => { resolver = r; });
    const especulativo = opts.especulativo === true;
    const turno: Turno = {
      id: ++this.contador,
      texto,
      interno: opts.interno === true,
      especulativo,
      confirmado: !especulativo,
      usuarioComprometido: false,
      confirmacion,
      resolverConfirmacion: resolver,
      buffer: "",
      abort: new AbortController(),
      stream: null,
      esperaDesdeMs: Date.now(),
      streamDesdeMs: null,
      primerTextoMs: null,
      textoEnviado: "",
      textoAbierto: false,
      interrumpido: false,
    };
    if (!especulativo) resolver(true);
    this.turnoVivo = turno;
    this.cadena = this.cadena
      .then(() => this.correrTurno(turno))
      .catch((e) => console.error("[RELAY] Error en el turno:", e instanceof Error ? e.message : e));
  }

  /** El texto final confirmó lo que ya estábamos preparando: se suelta. */
  private confirmar(turno: Turno, textoFinal: string) {
    turno.texto = textoFinal;
    turno.confirmado = true;
    turno.esperaDesdeMs = Date.now();
    // Solo si su turno ya está corriendo (la cola llegó a él): si no, una
    // herramienta de un turno anterior podría seguir en curso y su resultado
    // tiene que entrar al historial ANTES que estas palabras (la API exige
    // tool_result inmediatamente después del tool_use). correrTurno lo mete al
    // arrancar.
    if (turno.streamDesdeMs != null) this.comprometerUsuario(turno);
    this.aprovechados++;
    if (turno.buffer) {
      const pendiente = turno.buffer;
      turno.buffer = "";
      this.enviarTexto(turno, pendiente, false);
    }
    turno.resolverConfirmacion(true);
  }

  private descartar(turno: Turno) {
    this.descartados++;
    this.abortar(turno);
    turno.resolverConfirmacion(false);
    if (this.turnoVivo === turno) this.turnoVivo = null;
  }

  private abortar(turno: Turno) {
    // Una respuesta anticipada que nadie confirmará no puede dejar la cola
    // esperando para siempre.
    if (!turno.confirmado) turno.resolverConfirmacion(false);
    if (turno.abort.signal.aborted) return;
    turno.abort.abort();
    try { turno.stream?.abort(); } catch { /* ya terminó */ }
  }

  /** Mete al historial lo que dijo el cliente (una sola vez por turno). */
  private comprometerUsuario(turno: Turno) {
    if (turno.usuarioComprometido) return;
    turno.usuarioComprometido = true;
    let contenido = turno.texto;
    if (!turno.interno) {
      const hora = ultimaHoraExplicita(turno.texto);
      if (hora) this.horaExplicita = { hora, detectadaEl: Date.now() };
      const anotacion = anotacionHorariaParaAgente(turno.texto);
      if (anotacion) contenido += `\n${anotacion}`;
      const itemId = `relay-${turno.id}`;
      this.onItemCreated?.(itemId);
      this.onTranscript?.(turno.texto, "user", itemId);
    }
    this.agregarMensaje({ role: "user", content: contenido });
  }

  /** Agrega al historial; dos del mismo rol seguidos se funden en uno. */
  private agregarMensaje(m: Anthropic.MessageParam) {
    const ultimo = this.mensajes[this.mensajes.length - 1];
    if (ultimo && ultimo.role === m.role) {
      const aBloques = (c: Anthropic.MessageParam["content"]) =>
        (typeof c === "string" ? [{ type: "text" as const, text: c }] : c) as Anthropic.ContentBlockParam[];
      ultimo.content = [...aBloques(ultimo.content), ...aBloques(m.content)];
      return;
    }
    this.mensajes.push(m);
  }

  private recortarUltimaRespuesta(dicho: string) {
    const ultimo = this.mensajes[this.mensajes.length - 1];
    if (!ultimo || ultimo.role !== "assistant" || typeof ultimo.content === "string") return;
    const bloques = ultimo.content as Anthropic.ContentBlockParam[];
    if (!bloques.every((b) => b.type === "text")) return; // con herramientas no se toca
    ultimo.content = [{ type: "text", text: `${dicho}…` }];
  }

  // ── El turno: Claude escribe, la voz lo dice, las herramientas corren ────

  private async correrTurno(turno: Turno): Promise<void> {
    if (this.cerrado || !this.cliente) return;
    if (turno.confirmado) this.comprometerUsuario(turno);
    if (turno.abort.signal.aborted) return;

    for (let vuelta = 0; vuelta < 6; vuelta++) {
      if (turno.abort.signal.aborted || this.cerrado) return;
      const mensajes = turno.confirmado
        ? this.mensajes
        : [...this.mensajes, { role: "user" as const, content: turno.texto }];

      turno.textoEnviado = "";
      turno.streamDesdeMs = Date.now();
      let mensaje: Anthropic.Message;
      try {
        const stream = this.cliente.messages.stream(
          {
            model: this.modelo,
            max_tokens: 1024,
            system: this.sistema,
            tools: this.herramientas,
            messages: mensajes,
            // Caché automático del historial: cada turno relee lo anterior del caché.
            cache_control: { type: "ephemeral" },
            ...parametrosRazonamiento(this.modelo, this.pensar),
          } as unknown as Anthropic.MessageStreamParams,
          { signal: turno.abort.signal },
        );
        turno.stream = stream;
        stream.on("text", (delta) => this.escribir(turno, delta));
        mensaje = await stream.finalMessage();
        this.errores = 0;
      } catch (e) {
        this.contarUsoParcial(turno);
        if (turno.abort.signal.aborted) {
          this.cerrarAbortado(turno);
          return;
        }
        this.alFallarModelo(turno, e);
        return;
      } finally {
        turno.stream = null;
      }
      this.contarUso(mensaje.usage);

      // Respuesta anticipada: se escribió antes de saber si el cliente terminó.
      // Las herramientas NO corren hasta confirmarlo (podrían agendar algo que
      // el cliente no terminó de pedir).
      if (!turno.confirmado) {
        const ok = await Promise.race([
          turno.confirmacion,
          new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
        ]);
        if (!ok || turno.abort.signal.aborted) {
          if (!turno.confirmado) this.descartar(turno);
          return;
        }
      }

      const texto = mensaje.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const herramientas = mensaje.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      // El SDK instalado aún no tipa "refusal" (los modelos 5.x sí lo devuelven).
      if ((mensaje.stop_reason as string) === "refusal") {
        const aviso = "Perdón, con eso no te puedo ayudar por aquí. ¿Te ayudo con otra cosa?";
        this.cerrarTexto(turno);
        this.enviarTexto(turno, aviso, true);
        this.agregarMensaje({ role: "assistant", content: aviso });
        this.onTranscript?.(aviso, "assistant");
        return;
      }

      const contenido = mensaje.content.filter((b) => b.type !== "text" || b.text.trim().length > 0);
      if (contenido.length > 0) this.agregarMensaje({ role: "assistant", content: contenido as Anthropic.ContentBlockParam[] });
      if (texto) this.onTranscript?.(texto, "assistant");
      this.cerrarTexto(turno);

      if (herramientas.length === 0 || mensaje.stop_reason !== "tool_use") return;

      // Frase de espera si el modelo no dijo nada antes de una herramienta lenta.
      if (!texto) {
        const lenta = herramientas.find((h) => FUNCIONES_CON_ESPERA.has(h.name));
        if (lenta) this.enviarTexto(turno, fraseEspera(lenta.name, lenta.input), true);
      }

      const resultados: Anthropic.ToolResultBlockParam[] = [];
      for (const h of herramientas) {
        resultados.push(await this.ejecutar(h));
      }
      this.agregarMensaje({ role: "user", content: resultados });

      // Colgar cierra la conversación: nada de una segunda despedida encima.
      if (this.colgarPedido || herramientas.some((h) => h.name === "colgar_llamada")) return;
      // El cliente habló mientras corría la herramienta: su nuevo turno (en
      // cola) verá los resultados y contestará a ambos.
      if (turno.abort.signal.aborted || turno.interrumpido) return;
    }
    console.warn(`[RELAY] Turno ${turno.id}: demasiadas vueltas de herramientas — se corta`);
  }

  private async ejecutar(h: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    if (!this.onFunctionCall) {
      return { type: "tool_result", tool_use_id: h.id, is_error: true, content: "Herramienta no disponible" };
    }
    let args: any = h.input && typeof h.input === "object" && !Array.isArray(h.input) ? h.input : null;
    if (!args) {
      return { type: "tool_result", tool_use_id: h.id, is_error: true, content: "Argumentos inválidos: vuelve a intentarlo con un objeto JSON." };
    }
    if (this.horaExplicita && Date.now() - this.horaExplicita.detectadaEl < 120_000) {
      args = normalizarArgumentosConHora(args, this.horaExplicita.hora);
    }
    console.log(`[RELAY] Herramienta ${h.name}(${JSON.stringify(args).slice(0, 300)})`);
    try {
      const resultado = await this.onFunctionCall(h.name, args, h.id);
      return { type: "tool_result", tool_use_id: h.id, content: JSON.stringify(resultado ?? { ok: true }).slice(0, 8000) };
    } catch (e) {
      console.error(`[RELAY] Error en ${h.name}:`, e instanceof Error ? e.message : e);
      return { type: "tool_result", tool_use_id: h.id, is_error: true, content: JSON.stringify({ error: "Error procesando la acción" }) };
    }
  }

  private alFallarModelo(turno: Turno, e: unknown) {
    const detalle = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[RELAY] Claude falló (turno ${turno.id}):`, detalle.slice(0, 400));
    this.onErrorModelo?.(detalle);
    this.errores++;
    if (!turno.confirmado) {
      // Anticipada: se tira y el texto final abre un turno normal que reintenta.
      this.descartar(turno);
      return;
    }
    if (this.errores >= 3 || /credit balance|insufficient|authentication|invalid x-api-key|permission/i.test(detalle)) {
      // Llave o crédito: no se arregla solo en esta llamada ni en la siguiente.
      if (/credit balance|insufficient|authentication|invalid x-api-key|permission/i.test(detalle)) marcarRelayCaido(detalle);
      this.onCaida?.(`Claude no responde: ${detalle.slice(0, 200)}`);
      return;
    }
    this.cerrarTexto(turno);
    this.enviarTexto(turno, "Perdón, se me fue la señal un segundo. ¿Me lo repites?", true);
  }

  /** Abortado a media respuesta: el historial guarda lo que sí se alcanzó a decir. */
  private cerrarAbortado(turno: Turno) {
    if (!turno.confirmado) return;
    const dicho = turno.textoEnviado.trim();
    if (dicho) {
      this.agregarMensaje({ role: "assistant", content: `${dicho}…` });
      this.onTranscript?.(dicho, "assistant");
    }
    if (!turno.interrumpido) this.cerrarTexto(turno);
    else turno.textoAbierto = false; // Telnyx ya cortó esa frase
  }

  // ── Salida a la voz ──────────────────────────────────────────────────────

  private escribir(turno: Turno, delta: string) {
    if (turno.abort.signal.aborted) return;
    const limpio = textoParaVoz(delta);
    if (!limpio) return;
    if (!turno.confirmado) {
      turno.buffer += limpio;
      return;
    }
    this.enviarTexto(turno, limpio, false);
  }

  private enviarTexto(turno: Turno | null, token: string, last: boolean) {
    if (this.cerrado || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type: "text", token, last }));
    } catch {
      return;
    }
    this.uso.caracteres += token.length;
    this.finHablaMs = Math.max(this.finHablaMs, Date.now()) + msParaDecir(token);
    if (!turno) return;
    turno.textoEnviado += token;
    turno.textoAbierto = !last;
    if (turno.primerTextoMs == null && token.trim() && !turno.interno) {
      turno.primerTextoMs = Date.now();
      this.registrarLatencia(turno);
    }
  }

  private cerrarTexto(turno: Turno) {
    if (!turno.textoAbierto) return;
    this.enviarTexto(turno, this.tokenVacioOk ? "" : " ", true);
  }

  private registrarLatencia(t: Turno) {
    const fin = t.primerTextoMs!;
    const fila = {
      totalMs: Math.max(0, fin - t.esperaDesdeMs),
      esperaMs: Math.max(0, (t.streamDesdeMs ?? fin) - t.esperaDesdeMs),
      modeloMs: Math.max(0, fin - (t.streamDesdeMs ?? fin)),
      temprano: t.especulativo,
    };
    this.latencias.push(fila);
    console.log(
      `[LATENCIA] turno ${this.latencias.length}: ${fila.totalMs} ms desde el texto final` +
        `${fila.temprano ? " (respuesta anticipada)" : ""} · modelo hasta primer texto ${fila.modeloMs} ms`,
    );
  }

  // ── Consumo ──────────────────────────────────────────────────────────────

  private contarUso(u: Anthropic.Usage | undefined) {
    if (!u) return;
    this.uso.entrada += u.input_tokens || 0;
    this.uso.salida += u.output_tokens || 0;
    this.uso.cacheLeido += u.cache_read_input_tokens || 0;
    this.uso.cacheEscrito += u.cache_creation_input_tokens || 0;
  }

  /** Una respuesta abortada también se cobra: lo que alcanzó a leer y escribir. */
  private contarUsoParcial(turno: Turno) {
    try {
      this.contarUso(turno.stream?.currentMessage?.usage);
    } catch { /* sin datos */ }
  }
}
