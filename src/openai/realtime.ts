import WebSocket from "ws";
import { config } from "../utils/config";
import {
  anotacionHorariaParaAgente,
  esAnotacionHoraria,
  normalizarArgumentosConHora,
  ultimaHoraExplicita,
  type HoraExplicita,
} from "../utils/normalizar-hora";

export interface HerramientaVoz {
  type: "function";
  name: string;
  description: string;
  parameters: any;
}

// Voces disponibles en gpt-realtime (GA): alloy, ash, ballad, cedar, coral,
// echo, marin, sage, shimmer, verse. Default: marin (más natural en español).
const VOZ_DEFAULT = "marin";

// MODELO con FALLBACK automático: intentamos primero la versión 2.1
// (jul 2026: −25% latencia p95, mejor manejo de ruido/interrupciones y de
// números dictados). Si la cuenta aún no la tiene habilitada, la conexión se
// reintenta sola con el alias estable — una llamada JAMÁS se pierde por
// apostar al modelo nuevo. Override manual con REALTIME_MODEL en el env.
const MODELO_PREFERIDO = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
const MODELO_FALLBACK = "gpt-realtime";

// Formato de audio para Twilio: G.711 μ-law a 8kHz.
// En GA la API espera objeto con `type`, valor "audio/pcmu" (codec estándar).
const FORMATO_AUDIO_TWILIO = { type: "audio/pcmu" as const };

// Precios gpt-realtime (GA) en USD por 1M de tokens. Actualizar aquí si OpenAI
// cambia tarifas. Ref (jul 2026): audio in 32 · audio out 64 · texto in 4 ·
// texto out 16 · cacheado (texto o audio) 0.40. El cache es lo que decide si una
// llamada larga sale barata o cara — por eso lo contamos aparte.
const PRECIOS_REALTIME_USD_POR_1M = {
  audioIn: 32,
  audioOut: 64,
  textIn: 4,
  textOut: 16,
  cached: 0.4,
} as const;

// Funciones pesadas que hacen un fetch a Odin y tardan (verificación de
// disponibilidad, búsqueda de slots, creación en BD, cold start de Vercel).
// Mientras se resuelven, el agente dice una frase de espera para no dejar la
// línea en silencio — igual que hacen Retell/Vapi con sus "filler words".
//
// NO incluimos escalar_humano (ya dice "te paso con un asesor" y tiene una
// transferencia cronometrada que una frase de espera descuadraría) ni
// registrar_pregunta (se llama en casi cada pregunta sin respuesta; un filler
// ahí haría sentir lento al agente en la conversación normal).
const FUNCIONES_CON_ESPERA = new Set<string>([
  "agendar_cita",
  "cancelar_cita",
  "reagendar_cita",
  "solicitar_reserva",
]);

// UNA sola frase de espera por situación. Se le pasa al modelo para que la diga
// con su propia voz Realtime (sin corte de voz). Cortas a propósito: entre menos
// audio suene, menos riesgo de que el eco/ruido la corte o se encime con el
// mensaje real.
function fraseEspera(nombre: string, args: any): string {
  switch (nombre) {
    case "agendar_cita":
    case "reagendar_cita":
      return "Permíteme, reviso la agenda.";
    case "cancelar_cita":
      return "Permíteme, reviso tu cita.";
    case "solicitar_reserva":
      // En la confirmación de pago NO se verifica disponibilidad → frase distinta,
      // para no decir "déjame verificar la disponibilidad" cuando ya hubo pago.
      return args?.pagoReportado === true
        ? "Permíteme, estoy validando tu pago."
        : "Claro, déjame verificar la disponibilidad, un momento.";
    default:
      return "Permíteme un momento.";
  }
}

// Cuánto protegemos la frase de espera (ms) de ser cortada por eco/ruido. Es
// una estimación de su duración hablada; durante esta ventana no interrumpimos.
const PROTEGER_FRASE_MS = 4000;

// Silencio (ms) tras el último fragmento de habla del cliente antes de que el
// agente responda. Sirve para AGRUPAR varios fragmentos cortos ("ok"… "ok"…) en
// una sola respuesta en vez de contestar a cada uno. Cada vez que el cliente
// (re)empieza a hablar, este temporizador se reinicia.
// 450ms (antes 600): el VAD semántico YA decide fin-de-turno por contenido;
// este debounce es solo el colchón anti-fragmentos. Override: VOZ_DEBOUNCE_MS.
const DEBOUNCE_RESPUESTA_MS = Number(process.env.VOZ_DEBOUNCE_MS) || 450;

// Eagerness del VAD semántico: qué tan rápido decide que el cliente terminó.
// "low" era MUY conservador → esperas variables de 1-3s según cómo sonara la
// frase (la causa #1 de la latencia inconsistente). "medium" responde bastante
// más rápido con pocas falsas entradas; ajustable con VOZ_VAD_EAGERNESS
// (low | medium | high | auto) sin redeploy de código.
const VAD_EAGERNESS = (["low", "medium", "high", "auto"].includes(process.env.VOZ_VAD_EAGERNESS || "")
  ? process.env.VOZ_VAD_EAGERNESS
  : "medium") as "low" | "medium" | "high" | "auto";

// Auto-sanación anti-mudez: si `respondiendo` se queda atorado en true (un
// response.done perdido tras una cancelación), el agente quedaría CALLADO para
// siempre. Si al ir a responder llevamos más de este tiempo sin actividad real
// de respuesta (created/delta/done), asumimos flag rancio y respondemos igual.
const RESPUESTA_RANCIA_MS = 6000;

export class OpenAIRealtime {
  private ws: WebSocket | null = null;
  private onAudioDelta: ((base64Audio: string) => void) | null = null;
  private onTranscript: ((texto: string, role: "user" | "assistant", itemId?: string) => void) | null = null;
  private onItemCreated: ((itemId: string) => void) | null = null;
  private onInterrupcion: (() => void) | null = null;
  private onFunctionCall: ((name: string, args: any, callId: string) => Promise<any>) | null = null;
  private conectado: boolean = false;
  private systemPrompt: string;
  private tools: HerramientaVoz[];
  private voz: string;
  /** Velocidad de la voz (0.25–1.5, 1.0 default). Se fija al configurar la sesión. */
  private velocidad: number | null = null;
  /** Con qué modelo quedó la sesión (preferido o fallback) — para logs. */
  private modeloActivo: string = MODELO_PREFERIDO;
  private respondiendo: boolean = false;
  private graceUntil: number = 0;
  private saludoEnviado: boolean = false;
  private cancelacionEnCurso: boolean = false;
  /** Espera SILENCIOSA: la frase de espera ya terminó y el fetch sigue en
   *  curso. El pipeline usa este hook para reproducir el tecleo. */
  private onEspera: ((activa: boolean) => void) | null = null;

  // Contabilidad de costo real: acumula los tokens que la API reporta en cada
  // response.done (msg.response.usage). Antes se mandaba costoUsd:0 a Odin y la
  // voz salía "gratis" en los márgenes. Esto la hace medible por llamada.
  private uso = { audioIn: 0, textIn: 0, cachedAudioIn: 0, cachedTextIn: 0, audioOut: 0, textOut: 0 };

  // Acumulador de argumentos de la función en curso
  private funcionActual: { callId: string; name: string; args: string } | null = null;

  // === Frase de espera durante funciones lentas ===
  // funcionLentaPendiente: nombre de la función cuyo fetch sigue en curso (o null).
  // funcionLentaArgs: args parseados de esa función (para elegir la frase correcta).
  // fillerActivo: true mientras se genera la frase de espera.
  // resultadoPendiente: resultado del fetch ya listo (su item ya se mandó a la API);
  //   solo falta que el agente lo diga, en cuanto no haya otra respuesta activa.
  // esperaInterrumpida: el cliente habló durante la espera → no hablar encima de él.
  private funcionLentaPendiente: string | null = null;
  private funcionLentaArgs: any = null;
  private fillerActivo: boolean = false;
  private resultadoPendiente: { callId: string; resultado: any } | null = null;
  private esperaInterrumpida: boolean = false;

  // Debounce para agrupar la entrada del cliente en una sola respuesta. Se
  // reinicia cada vez que el cliente (re)empieza a hablar.
  private respuestaTimer: ReturnType<typeof setTimeout> | null = null;
  /** Esperamos brevemente el transcript para poder anotar AM/PM antes de responder. */
  private esperandoTranscripcionHasta: number = 0;
  /** Última hora explícita: red determinista para los argumentos de funciones. */
  private horaExplicitaTurno: { hora: HoraExplicita; detectadaEl: number } | null = null;

  // Última señal de vida de una respuesta (created/delta/done). Si
  // `respondiendo` quedó atorado sin actividad, la auto-sanación lo resetea
  // en vez de dejar al agente mudo — ver programarRespuestaUsuario().
  private ultimaActividadRespuesta: number = 0;

  constructor(systemPrompt: string, tools: HerramientaVoz[] = [], voz: string = VOZ_DEFAULT) {
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.voz = voz;
  }

  // Abre WebSocket y espera session.created. Intenta primero MODELO_PREFERIDO
  // y, si el WS falla antes de crear sesión (modelo no habilitado en la
  // cuenta, typo del env), reintenta UNA vez con MODELO_FALLBACK.
  async abrirConexion(): Promise<void> {
    try {
      await this.conectarModelo(MODELO_PREFERIDO);
      this.modeloActivo = MODELO_PREFERIDO;
    } catch (err: any) {
      if (MODELO_PREFERIDO === MODELO_FALLBACK) throw err;
      console.warn(`[REALTIME] ${MODELO_PREFERIDO} no disponible (${err?.message || err}) → fallback a ${MODELO_FALLBACK}`);
      await this.conectarModelo(MODELO_FALLBACK);
      this.modeloActivo = MODELO_FALLBACK;
    }
  }

  private conectarModelo(modelo: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${modelo}`;
      this.ws = new WebSocket(url, {
        headers: { "Authorization": `Bearer ${config.openaiApiKey}` },
      });

      let inicializado = false;

      this.ws.on("open", () => {
        this.conectado = true;
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "session.created" && !inicializado) {
            inicializado = true;
            console.log(`[REALTIME] Sesión lista (${modelo}, voz=${this.voz})`);
            resolve();
          }
          this.handleMessage(msg);
        } catch {}
      });

      this.ws.on("error", (err) => {
        console.error("[REALTIME] Error:", err.message);
        this.conectado = false;
        if (!inicializado) reject(err);
      });

      this.ws.on("close", (code, reason) => {
        console.log(`[REALTIME] Cerrado: ${code} ${reason}`);
        this.conectado = false;
        if (!inicializado) reject(new Error(`WS cerrado antes de session.created (code ${code})`));
      });
    });
  }

  // ============================================================================
  // FORMATO GA (Realtime API General Availability):
  //   - session.update.session debe tener `type: "realtime"`
  //   - audio.input  → { format, transcription, turn_detection }
  //   - audio.output → { format, voice }
  //   - `output_modalities` reemplaza al `modalities` viejo
  //   - voice va dentro de audio.output, no en raíz
  //   - formato es objeto { type: "audio/pcmu" } no string "g711_ulaw"
  // ============================================================================
  configurarSesion(prompt: string, tools: HerramientaVoz[] = [], voz?: string, velocidad?: number | null) {
    this.systemPrompt = prompt;
    this.tools = tools;
    if (voz) this.voz = voz;
    // Velocidad de habla: clamp al rango soportado por la API (0.25–1.5).
    if (typeof velocidad === "number" && Number.isFinite(velocidad)) {
      this.velocidad = Math.min(1.5, Math.max(0.25, velocidad));
    }

    if (!this.ws || !this.conectado) return;

    const sessionConfig: any = {
      type: "realtime",
      model: this.modeloActivo,
      output_modalities: ["audio"],
      instructions: prompt,
      audio: {
        input: {
          format: FORMATO_AUDIO_TWILIO,
          transcription: { model: "whisper-1", language: "es" },
          turn_detection: {
            type: "semantic_vad",
            // eagerness configurable (default "medium"): "low" causaba esperas
            // de 1-3s VARIABLES según cómo sonara la frase del cliente — la
            // principal causa de latencia inconsistente. Las interrupciones
            // falsas del agente las siguen conteniendo graceUntil + los guards
            // de speech_started, no el eagerness.
            eagerness: VAD_EAGERNESS,
            // create_response:false → NOSOTROS creamos la respuesta, no OpenAI.
            // Así agrupamos TODO lo que el cliente dijo (aunque lo diga en varios
            // fragmentos cortos como "ok"… "ok"…) en UNA sola respuesta, en vez de
            // contestar a cada fragmento. La disparamos tras un breve silencio
            // (debounce) en speech_stopped — ver programarRespuestaUsuario().
            create_response: false,
            // NO dejar que OpenAI cancele respuestas automáticamente.
            // Nosotros lo manejamos en speech_started para sincronizar con Twilio.
            interrupt_response: false,
          },
        },
        output: {
          format: FORMATO_AUDIO_TWILIO,
          voice: this.voz,
          // speed solo cambia la velocidad de REPRODUCCIÓN; el ritmo real lo
          // dirige el bloque de actuación del prompt. Se omite si no se pidió.
          ...(this.velocidad != null && this.velocidad !== 1 ? { speed: this.velocidad } : {}),
        },
      },
    };

    if (tools.length > 0) {
      sessionConfig.tools = tools;
      sessionConfig.tool_choice = "auto";
    }

    this.ws.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
  }

  // Update sin tocar la voz (mid-conversation, después del primer audio).
  // OpenAI rechaza session.update con voice una vez que ya hay audio del
  // asistente. Por eso este método NO incluye audio.output.voice.
  actualizarConfiguracion(prompt: string, tools: HerramientaVoz[] = []) {
    this.systemPrompt = prompt;
    this.tools = tools;

    if (!this.ws || !this.conectado) return;

    const sessionConfig: any = {
      type: "realtime",
      instructions: prompt,
    };

    if (tools.length > 0) {
      sessionConfig.tools = tools;
      sessionConfig.tool_choice = "auto";
    }

    this.ws.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
    console.log("[REALTIME] Instrucciones y herramientas actualizadas (voz preservada)");
  }

  async conectar(): Promise<void> {
    await this.abrirConexion();
    this.configurarSesion(this.systemPrompt, this.tools);
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case "session.created":
        // Ya se logea en abrirConexion cuando llega este evento
        break;

      case "session.updated":
        if (!this.saludoEnviado) {
          this.saludoEnviado = true;
          console.log("[REALTIME] Sesión configurada → enviando saludo");
          this.graceUntil = Date.now() + 1500;
          if (this.ws && this.conectado) {
            // SALUDO VARIADO: cada llamada arranca con un matiz distinto — un
            // humano jamás contesta dos veces con exactamente la misma frase.
            // Si el negocio configuró SALUDO INICIAL (está en el prompt), el
            // modelo lo respeta; esto solo varía el color de la entrega.
            const ESTILOS = [
              "con energía cálida, como si te alegrara la llamada",
              "sonriendo (que se escuche amable)",
              "tranquila y profesional",
              "con tono servicial y ágil",
            ];
            const estilo = ESTILOS[Math.floor(Math.random() * ESTILOS.length)];
            // GA: response.create ya NO acepta `modalities` — solo `instructions`
            this.ws.send(JSON.stringify({
              type: "response.create",
              response: {
                instructions: `Saluda al cliente en español mexicano, ${estilo}. Si tus instrucciones traen un SALUDO INICIAL, transmítelo con tus palabras; si no, algo breve tipo "Hola, ¿en qué te puedo ayudar?". UNA sola oración corta, con formulación natural (no leas un guion). Nada más.`,
              },
            }));
          }
        } else {
          console.log("[REALTIME] Configuración actualizada (sesión ya activa)");
        }
        break;

      case "conversation.item.created":
      case "conversation.item.added":
        if (
          msg.item?.role === "user" &&
          msg.item?.id &&
          this.onItemCreated &&
          !msg.item?.content?.some((c: any) => esAnotacionHoraria(c?.text))
        ) {
          this.onItemCreated(msg.item.id);
        }
        break;

      // GA: nuevos nombres de eventos (con prefijo "output_")
      case "response.output_audio.delta":
      case "response.audio.delta": // backward compat por si alterna
        this.ultimaActividadRespuesta = Date.now();
        if (msg.delta && this.onAudioDelta) {
          this.onAudioDelta(msg.delta);
        }
        break;

      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        // Las frases de espera no van al historial: son relleno, no contenido.
        if (this.fillerActivo) break;
        if (msg.transcript && this.onTranscript) {
          this.onTranscript(msg.transcript, "assistant");
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        this.esperandoTranscripcionHasta = 0;
        if (msg.transcript && this.ws && this.conectado) {
          const hora = ultimaHoraExplicita(msg.transcript);
          if (hora) this.horaExplicitaTurno = { hora, detectadaEl: Date.now() };
          const anotacion = anotacionHorariaParaAgente(msg.transcript);
          if (anotacion) {
            // Mensaje interno soportado por Realtime: entra al contexto antes
            // de response.create, pero no al historial visible de la llamada.
            this.ws.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: anotacion }],
              },
            }));
          }
        }
        if (msg.transcript && this.onTranscript) {
          this.onTranscript(msg.transcript, "user", msg.item_id);
          console.log(`[REALTIME] Usuario: "${msg.transcript}"`);
        }
        // Reinicia la respuesta después de insertar la equivalencia, no antes.
        this.programarRespuestaUsuario(25);
        break;

      case "input_audio_buffer.speech_started":
        // El cliente (vuelve a) hablar → reinicia el debounce para AGRUPAR todo lo
        // que diga en una sola respuesta (no contestar fragmento por fragmento).
        this.cancelarDebounceRespuesta();
        this.esperandoTranscripcionHasta = 0;
        // NO cancelar mientras se generan los argumentos de una función: cancelar
        // truncaría el JSON y la acción (p. ej. la reserva) se mandaría vacía.
        if (this.funcionActual) break;
        // graceUntil protege la frase de espera (y el arranque del saludo) de que
        // el eco/ruido las corte durante su ventana estimada de reproducción.
        // El cliente habló: si estaba sonando el tecleo de espera, se corta —
        // jamás debe teclear encima de la voz del cliente.
        this.onEspera?.(false);
        if (this.respondiendo && this.ws && this.conectado && Date.now() > this.graceUntil && !this.cancelacionEnCurso) {
          this.cancelacionEnCurso = true;
          if (this.onInterrupcion) this.onInterrupcion();
          this.ws.send(JSON.stringify({ type: "response.cancel" }));
          console.log("[REALTIME] INTERRUPCIÓN → audio cortado + cancel enviado");
        }
        break;

      case "input_audio_buffer.speech_stopped":
        // El cliente terminó (por ahora). Espera un poco por si sigue hablando y
        // recién entonces responde UNA sola vez con todo lo que dijo.
        this.esperandoTranscripcionHasta = Date.now() + 1200;
        this.programarRespuestaUsuario();
        break;

      case "response.created":
        this.respondiendo = true;
        this.cancelacionEnCurso = false;
        this.ultimaActividadRespuesta = Date.now();
        break;

      case "response.done": {
        this.respondiendo = false;
        this.cancelacionEnCurso = false;
        this.ultimaActividadRespuesta = Date.now();
        // Cuenta el consumo de ESTE response (incluye cancelados y frases de
        // espera: la API igual cobra los tokens que alcanzó a generar).
        this.acumularUso(msg.response?.usage);
        const cancelada = msg.response?.status === "cancelled";
        const eraFiller = this.fillerActivo;
        this.fillerActivo = false;

        if (cancelada) {
          console.log("[REALTIME] Respuesta cancelada");
          // El cliente interrumpió: no encadenar ni hablar el resultado encima de él.
          if (eraFiller || this.funcionLentaPendiente || this.resultadoPendiente) {
            this.esperaInterrumpida = true;
          }
          this.funcionLentaPendiente = null;
          this.funcionLentaArgs = null;
          this.resultadoPendiente = null;
          break;
        }

        if (eraFiller) {
          // La frase de espera terminó de generarse. Si el resultado ya llegó, se
          // dice ahora (se encola en Twilio justo después de la frase).
          this.intentarHablarResultado();
          // ¿El fetch sigue en curso? Entonces viene una ESPERA SILENCIOSA:
          // el pipeline reproduce el tecleo ("está buscando en el sistema")
          // hasta que llegue el resultado o el cliente hable.
          if (this.funcionLentaPendiente && !this.resultadoPendiente && !this.esperaInterrumpida) {
            this.onEspera?.(true);
          }
          break;
        }

        // Terminó la respuesta que contenía el function_call. Si el fetch sigue en
        // curso y aún no hay resultado, di la (única) frase de espera.
        if (this.funcionLentaPendiente && !this.resultadoPendiente) {
          this.reproducirFraseEspera(this.funcionLentaPendiente, this.funcionLentaArgs);
          break;
        }

        // El fetch ya había resuelto (rápido): habla el resultado ahora.
        this.intentarHablarResultado();
        break;
      }

      // === FUNCTION CALLING ===
      case "response.output_item.added":
        if (msg.item?.type === "function_call") {
          const nombreFn = msg.item.name || "";
          this.funcionActual = {
            callId: msg.item.call_id || "",
            name: nombreFn,
            args: "",
          };
          // Si la función tira a la red (puede tardar), prepárate para decir la
          // frase de espera cuando termine de emitirse el function_call. Reset del
          // estado para arrancar limpio en cada función.
          if (FUNCIONES_CON_ESPERA.has(nombreFn)) {
            this.funcionLentaPendiente = nombreFn;
            this.funcionLentaArgs = null;
            this.resultadoPendiente = null;
            this.esperaInterrumpida = false;
          }
          console.log(`[REALTIME] Función iniciada: ${nombreFn}`);
        }
        break;

      case "response.function_call_arguments.delta":
        if (this.funcionActual && msg.delta) {
          this.funcionActual.args += msg.delta;
        }
        break;

      case "response.function_call_arguments.done":
        if (this.funcionActual && this.onFunctionCall) {
          const { callId, name } = this.funcionActual;
          const argsStr = msg.arguments || this.funcionActual.args;
          this.funcionActual = null;
          console.log(`[REALTIME] Función lista: ${name}(${argsStr})`);
          let args: any = {};
          try { args = JSON.parse(argsStr); } catch (e) {
            console.warn(`[REALTIME] Args de ${name} no son JSON válido (posible truncado): ${argsStr}`);
          }
          if (this.horaExplicitaTurno && Date.now() - this.horaExplicitaTurno.detectadaEl < 120_000) {
            args = normalizarArgumentosConHora(args, this.horaExplicitaTurno.hora);
          }
          this.horaExplicitaTurno = null;
          // Guardamos los args para elegir la frase de espera correcta (p. ej.
          // distinguir verificación de disponibilidad vs confirmación de pago).
          if (this.funcionLentaPendiente === name) this.funcionLentaArgs = args;
          this.onFunctionCall(name, args, callId)
            .then((resultado) => this.alResolverFuncion(callId, resultado))
            .catch((err) => {
              console.error("[REALTIME] Error en función:", err);
              this.alResolverFuncion(callId, { error: "Error procesando la acción" });
            });
        }
        break;

      case "error":
        if (msg.error?.code === "response_cancel_not_active") break;
        // Carrera benigna: intentamos crear una respuesta mientras otra seguía
        // activa (p. ej. una frase de espera). La ignoramos; el flujo se resincroniza
        // solo en el siguiente response.done.
        if (msg.error?.code === "conversation_already_has_active_response") break;
        console.error("[REALTIME] Error:", JSON.stringify(msg.error));
        break;

      case "rate_limits.updated":
        break;
    }
  }

  // El fetch de la función terminó. Mete el resultado como function_call_output
  // (esto es seguro en cualquier momento) y lo deja pendiente de hablar. El
  // momento exacto en que se dice lo decide intentarHablarResultado().
  private alResolverFuncion(callId: string, resultado: any) {
    this.funcionLentaPendiente = null;
    this.funcionLentaArgs = null;
    if (!this.ws || !this.conectado) return;

    this.ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(resultado),
      },
    }));
    console.log(`[REALTIME] Resultado función listo (callId=${callId}):`, resultado);

    this.resultadoPendiente = { callId, resultado };
    this.intentarHablarResultado();
  }

  // Dice el resultado del fetch en cuanto:
  //   - ya llegó el resultado;
  //   - no se está generando la frase de espera (esperamos a su response.done);
  //   - no hay otra respuesta activa.
  // El audio del resultado se encola en Twilio justo después de la frase de
  // espera, así que se oyen en orden. Si el cliente interrumpió la espera, se
  // descarta el habla (el item ya quedó en contexto para el siguiente turno).
  private intentarHablarResultado() {
    if (!this.resultadoPendiente) return;
    if (this.esperaInterrumpida) {
      this.esperaInterrumpida = false;
      this.resultadoPendiente = null;
      return;
    }
    if (this.fillerActivo) return; // la frase de espera aún se está generando
    if (this.respondiendo) return; // otra respuesta sigue activa
    this.resultadoPendiente = null;
    this.crearRespuesta();
  }

  // Pide a la API que genere la respuesta hablada con el contexto actual.
  // Marca respondiendo=true de forma optimista para cerrar la ventana de carrera
  // entre el resultado del fetch y el fin de una frase de espera.
  private crearRespuesta() {
    if (!this.ws || !this.conectado) return;
    // Va a hablar: la espera silenciosa (tecleo) termina aquí SIEMPRE.
    this.onEspera?.(false);
    this.respondiendo = true;
    this.ws.send(JSON.stringify({ type: "response.create" }));
  }

  private cancelarDebounceRespuesta() {
    if (this.respuestaTimer) { clearTimeout(this.respuestaTimer); this.respuestaTimer = null; }
  }

  // Programa (con debounce) la respuesta del agente al cliente. Como el cliente
  // puede decir varias cosas seguidas, esperamos un breve silencio: si vuelve a
  // hablar antes, se reinicia y TODO se agrupa en una sola respuesta. No responde
  // si hay una función o frase de espera en curso (esas manejan su propia
  // respuesta) ni si ya hay otra respuesta activa.
  private programarRespuestaUsuario(delayMs = DEBOUNCE_RESPUESTA_MS) {
    this.cancelarDebounceRespuesta();
    this.respuestaTimer = setTimeout(() => {
      this.respuestaTimer = null;
      this.intentarRespuestaUsuarioProgramada();
    }, delayMs);
  }

  private intentarRespuestaUsuarioProgramada() {
    const espera = this.esperandoTranscripcionHasta - Date.now();
    if (espera > 0) {
      this.respuestaTimer = setTimeout(() => {
        this.respuestaTimer = null;
        this.intentarRespuestaUsuarioProgramada();
      }, Math.min(espera, 100));
      return;
    }
    this.esperandoTranscripcionHasta = 0;
    if (this.funcionActual || this.funcionLentaPendiente || this.fillerActivo) return;
    if (this.respondiendo) {
      // AUTO-SANACIÓN: si el flag lleva demasiado sin actividad real
      // (response.done perdido tras una cancelación), estaba dejando al
      // agente MUDO — el cliente hablaba y nadie contestaba jamás. Se
      // resetea el flag rancio y se responde de todos modos.
      if (Date.now() - this.ultimaActividadRespuesta > RESPUESTA_RANCIA_MS) {
        console.warn("[REALTIME] respondiendo=true RANCIO (sin actividad) → auto-sanación, respondiendo igual");
        this.respondiendo = false;
      } else {
        return;
      }
    }
    this.crearRespuesta();
  }

  // Hace que el agente diga UNA frase de espera con su propia voz mientras corre
  // el fetch. Es una respuesta fuera de banda (conversation:"none"): se oye pero
  // NO entra al historial ni rompe la adyacencia function_call → function_call_output.
  private reproducirFraseEspera(nombreFuncion: string, args: any) {
    if (!this.ws || !this.conectado) return;
    const frase = fraseEspera(nombreFuncion, args);
    this.fillerActivo = true;
    this.respondiendo = true; // optimista: evita doble response.create simultáneo
    // Protege la frase de que el eco/ruido la corte durante su reproducción.
    this.graceUntil = Date.now() + PROTEGER_FRASE_MS;
    this.ws.send(JSON.stringify({
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["audio"],
        instructions: `Di EXACTAMENTE esta frase en español mexicano, sin agregar ni cambiar nada, sin llamar a ninguna función: "${frase}"`,
        tool_choice: "none",
      },
    }));
    console.log(`[REALTIME] Frase de espera: "${frase}"`);
  }

  enviarAudio(base64Audio: string) {
    if (this.ws && this.conectado) {
      this.ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Audio,
      }));
    }
  }

  cancelarRespuesta() {
    if (this.ws && this.conectado && this.respondiendo) {
      this.ws.send(JSON.stringify({ type: "response.cancel" }));
      this.respondiendo = false;
    }
  }

  setOnAudioDelta(callback: (base64Audio: string) => void) { this.onAudioDelta = callback; }
  /** true = arranca espera silenciosa (fetch en curso, nadie hablando);
   *  false = terminó (va a hablar alguien o el cliente interrumpió). */
  setOnEspera(callback: (activa: boolean) => void) { this.onEspera = callback; }
  setOnTranscript(callback: (texto: string, role: "user" | "assistant", itemId?: string) => void) { this.onTranscript = callback; }
  setOnItemCreated(callback: (itemId: string) => void) { this.onItemCreated = callback; }
  setOnInterrupcion(callback: () => void) { this.onInterrupcion = callback; }
  setOnFunctionCall(callback: (name: string, args: any, callId: string) => Promise<any>) { this.onFunctionCall = callback; }

  // Acumula el usage de un response.done. La API reporta el desglose de tokens
  // de entrada (audio/texto, cacheados o no) y de salida.
  private acumularUso(usage: any) {
    if (!usage) return;
    const itd = usage.input_token_details || {};
    const otd = usage.output_token_details || {};
    const ctd = itd.cached_tokens_details || {};
    const audioIn = itd.audio_tokens || 0;
    const textIn = itd.text_tokens || 0;
    const cachedTotal = itd.cached_tokens || 0;
    // Si la API no desglosa el cache, aproximamos: el grueso del contexto es audio.
    const cachedAudio = ctd.audio_tokens ?? Math.min(cachedTotal, audioIn);
    const cachedText = ctd.text_tokens ?? Math.max(0, cachedTotal - cachedAudio);
    this.uso.audioIn += audioIn;
    this.uso.textIn += textIn;
    this.uso.cachedAudioIn += cachedAudio;
    this.uso.cachedTextIn += cachedText;
    this.uso.audioOut += otd.audio_tokens || 0;
    this.uso.textOut += otd.text_tokens || 0;
  }

  // Costo real en USD de la parte OpenAI Realtime de la llamada (sin Twilio ni
  // whisper). Los tokens cacheados se cobran a la tarifa reducida.
  costoUsdOpenAI(): number {
    const P = PRECIOS_REALTIME_USD_POR_1M;
    const u = this.uso;
    const audioInSinCache = Math.max(0, u.audioIn - u.cachedAudioIn);
    const textInSinCache = Math.max(0, u.textIn - u.cachedTextIn);
    return (
      audioInSinCache * P.audioIn +
      textInSinCache * P.textIn +
      u.cachedAudioIn * P.cached +
      u.cachedTextIn * P.cached +
      u.audioOut * P.audioOut +
      u.textOut * P.textOut
    ) / 1_000_000;
  }

  // Desglose de tokens + costo, para el log de fin de llamada y diagnóstico.
  resumenUso() {
    return { ...this.uso, costoUsd: this.costoUsdOpenAI() };
  }

  cerrar() {
    this.cancelarDebounceRespuesta();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
      this.conectado = false;
    }
  }

  get estaConectado() { return this.conectado; }
}
