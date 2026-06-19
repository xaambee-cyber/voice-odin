"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIRealtime = void 0;
const ws_1 = __importDefault(require("ws"));
const config_1 = require("../utils/config");
// Voces disponibles en gpt-realtime (GA): alloy, ash, ballad, cedar, coral,
// echo, marin, sage, shimmer, verse. Default: marin (más natural en español).
const VOZ_DEFAULT = "marin";
const MODELO = "gpt-realtime";
// Formato de audio para Twilio: G.711 μ-law a 8kHz.
// En GA la API espera objeto con `type`, valor "audio/pcmu" (codec estándar).
const FORMATO_AUDIO_TWILIO = { type: "audio/pcmu" };
// Funciones pesadas que hacen un fetch a Odin y tardan (verificación de
// disponibilidad, búsqueda de slots, creación en BD, cold start de Vercel).
// Mientras se resuelven, el agente dice una frase de espera para no dejar la
// línea en silencio — igual que hacen Retell/Vapi con sus "filler words".
//
// NO incluimos escalar_humano (ya dice "te paso con un asesor" y tiene una
// transferencia cronometrada que una frase de espera descuadraría) ni
// registrar_pregunta (se llama en casi cada pregunta sin respuesta; un filler
// ahí haría sentir lento al agente en la conversación normal).
const FUNCIONES_CON_ESPERA = new Set([
    "agendar_cita",
    "cancelar_cita",
    "reagendar_cita",
    "solicitar_reserva",
]);
// Frase de espera específica por situación (la PRIMERA que se dice). Se le pasa
// al modelo para que la diga con su propia voz Realtime, así no hay corte de voz.
function fraseEspera(nombre) {
    switch (nombre) {
        case "agendar_cita":
        case "reagendar_cita":
            return "Permíteme un momento, déjame revisar la agenda.";
        case "cancelar_cita":
            return "Permíteme un momento mientras reviso tu cita.";
        case "solicitar_reserva":
            return "Claro, déjame verificar la disponibilidad. Un momento, no cuelgues por favor.";
        default:
            return "Permíteme un momento, por favor.";
    }
}
// Si la función tarda más que la primera frase, se dice esta de refuerzo (una
// sola vez) para que el cliente sepa que seguimos en línea trabajando.
const FRASE_ESPERA_REFUERZO = "Gracias por tu paciencia, en un momento te confirmo.";
const MAX_FILLERS = 2;
class OpenAIRealtime {
    ws = null;
    onAudioDelta = null;
    onTranscript = null;
    onItemCreated = null;
    onInterrupcion = null;
    onFunctionCall = null;
    conectado = false;
    systemPrompt;
    tools;
    voz;
    respondiendo = false;
    graceUntil = 0;
    saludoEnviado = false;
    cancelacionEnCurso = false;
    // Acumulador de argumentos de la función en curso
    funcionActual = null;
    // === Estado de las frases de espera (filler) durante funciones lentas ===
    // funcionLentaPendiente: nombre de la función cuyo fetch sigue en curso (o null
    //   cuando ya resolvió). Sirve para decidir si encadenar frases de espera.
    // fillerActivo: true mientras suena una frase de espera.
    // fillersReproducidos: cuántas frases de espera van en ESTA función (cap MAX_FILLERS).
    // resultadoListoParaHablar: el resultado ya llegó y su item ya se envió a la API;
    //   solo falta el response.create para hablarlo, en cuanto termine la frase actual.
    // esperaInterrumpida: el cliente habló durante la espera → no hablar el resultado
    //   por encima de él; el siguiente turno (semantic_vad) lo aprovechará.
    funcionLentaPendiente = null;
    fillerActivo = false;
    fillersReproducidos = 0;
    resultadoListoParaHablar = false;
    esperaInterrumpida = false;
    constructor(systemPrompt, tools = [], voz = VOZ_DEFAULT) {
        this.systemPrompt = systemPrompt;
        this.tools = tools;
        this.voz = voz;
    }
    // Abre WebSocket y espera evento session.created antes de resolver.
    async abrirConexion() {
        return new Promise((resolve, reject) => {
            const url = `wss://api.openai.com/v1/realtime?model=${MODELO}`;
            this.ws = new ws_1.default(url, {
                headers: { "Authorization": `Bearer ${config_1.config.openaiApiKey}` },
            });
            let inicializado = false;
            this.ws.on("open", () => {
                this.conectado = true;
            });
            this.ws.on("message", (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === "session.created" && !inicializado) {
                        inicializado = true;
                        console.log(`[REALTIME] Sesión lista (${MODELO}, voz=${this.voz})`);
                        resolve();
                    }
                    this.handleMessage(msg);
                }
                catch { }
            });
            this.ws.on("error", (err) => {
                console.error("[REALTIME] Error:", err.message);
                this.conectado = false;
                if (!inicializado)
                    reject(err);
            });
            this.ws.on("close", (code, reason) => {
                console.log(`[REALTIME] Cerrado: ${code} ${reason}`);
                this.conectado = false;
                if (!inicializado)
                    reject(new Error(`WS cerrado antes de session.created (code ${code})`));
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
    configurarSesion(prompt, tools = [], voz) {
        this.systemPrompt = prompt;
        this.tools = tools;
        if (voz)
            this.voz = voz;
        if (!this.ws || !this.conectado)
            return;
        const sessionConfig = {
            type: "realtime",
            model: MODELO,
            output_modalities: ["audio"],
            instructions: prompt,
            audio: {
                input: {
                    format: FORMATO_AUDIO_TWILIO,
                    transcription: { model: "whisper-1", language: "es" },
                    turn_detection: {
                        type: "semantic_vad",
                        eagerness: "medium",
                        create_response: true,
                        // NO dejar que OpenAI cancele respuestas automáticamente.
                        // Nosotros lo manejamos en speech_started para sincronizar con Twilio.
                        interrupt_response: false,
                    },
                },
                output: {
                    format: FORMATO_AUDIO_TWILIO,
                    voice: this.voz,
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
    actualizarConfiguracion(prompt, tools = []) {
        this.systemPrompt = prompt;
        this.tools = tools;
        if (!this.ws || !this.conectado)
            return;
        const sessionConfig = {
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
    async conectar() {
        await this.abrirConexion();
        this.configurarSesion(this.systemPrompt, this.tools);
    }
    handleMessage(msg) {
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
                        // GA: response.create ya NO acepta `modalities` — solo `instructions`
                        this.ws.send(JSON.stringify({
                            type: "response.create",
                            response: {
                                instructions: "Saluda brevemente al cliente en español mexicano. Una sola oración corta como: 'Hola, ¿en qué te puedo ayudar?' Nada más.",
                            },
                        }));
                    }
                }
                else {
                    console.log("[REALTIME] Configuración actualizada (sesión ya activa)");
                }
                break;
            case "conversation.item.created":
            case "conversation.item.added":
                if (msg.item?.role === "user" && msg.item?.id && this.onItemCreated) {
                    this.onItemCreated(msg.item.id);
                }
                break;
            // GA: nuevos nombres de eventos (con prefijo "output_")
            case "response.output_audio.delta":
            case "response.audio.delta": // backward compat por si alterna
                if (msg.delta && this.onAudioDelta) {
                    this.onAudioDelta(msg.delta);
                }
                break;
            case "response.output_audio_transcript.done":
            case "response.audio_transcript.done":
                // Las frases de espera no van al historial: son relleno, no contenido.
                if (this.fillerActivo)
                    break;
                if (msg.transcript && this.onTranscript) {
                    this.onTranscript(msg.transcript, "assistant");
                }
                break;
            case "conversation.item.input_audio_transcription.completed":
                if (msg.transcript && this.onTranscript) {
                    this.onTranscript(msg.transcript, "user", msg.item_id);
                    console.log(`[REALTIME] Usuario: "${msg.transcript}"`);
                }
                break;
            case "input_audio_buffer.speech_started":
                if (this.respondiendo && this.ws && this.conectado && Date.now() > this.graceUntil && !this.cancelacionEnCurso) {
                    this.cancelacionEnCurso = true;
                    if (this.onInterrupcion)
                        this.onInterrupcion();
                    this.ws.send(JSON.stringify({ type: "response.cancel" }));
                    console.log("[REALTIME] INTERRUPCIÓN → audio cortado + cancel enviado");
                }
                break;
            case "input_audio_buffer.speech_stopped":
                break;
            case "response.created":
                this.respondiendo = true;
                this.cancelacionEnCurso = false;
                break;
            case "response.done": {
                this.respondiendo = false;
                this.cancelacionEnCurso = false;
                const cancelada = msg.response?.status === "cancelled";
                const eraFiller = this.fillerActivo;
                this.fillerActivo = false;
                if (cancelada) {
                    console.log("[REALTIME] Respuesta cancelada");
                    // El cliente interrumpió: dejar de encadenar frases de espera. Si el
                    // resultado estaba por hablarse, no lo decimos por encima de él.
                    if (eraFiller || this.funcionLentaPendiente || this.resultadoListoParaHablar) {
                        this.esperaInterrumpida = true;
                    }
                    this.funcionLentaPendiente = null;
                    this.resultadoListoParaHablar = false;
                    break;
                }
                // 1) El resultado real ya llegó y esperaba a que terminara la frase de
                //    espera en curso. Ahora sí: que el agente lo diga.
                if (this.resultadoListoParaHablar) {
                    this.resultadoListoParaHablar = false;
                    this.crearRespuesta();
                    break;
                }
                // 2) Sigue corriendo el fetch de una función lenta (acaba de terminar el
                //    function_call o una frase de espera previa): di otra frase de espera
                //    para no dejar la línea en silencio, hasta el tope MAX_FILLERS.
                if (this.funcionLentaPendiente && this.fillersReproducidos < MAX_FILLERS) {
                    this.reproducirFraseEspera(this.funcionLentaPendiente);
                }
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
                    // Si la función tira a la red (puede tardar), prepárate para decir una
                    // frase de espera cuando termine de emitirse el function_call. Reset del
                    // estado de espera para arrancar limpio en cada función.
                    if (FUNCIONES_CON_ESPERA.has(nombreFn)) {
                        this.funcionLentaPendiente = nombreFn;
                        this.fillersReproducidos = 0;
                        this.resultadoListoParaHablar = false;
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
                    let args = {};
                    try {
                        args = JSON.parse(argsStr);
                    }
                    catch { }
                    this.onFunctionCall(name, args, callId)
                        .then((resultado) => this.alResolverFuncion(callId, resultado))
                        .catch((err) => {
                        console.error("[REALTIME] Error en función:", err);
                        this.alResolverFuncion(callId, { error: "Error procesando la acción" });
                    });
                }
                break;
            case "error":
                if (msg.error?.code === "response_cancel_not_active")
                    break;
                // Carrera benigna: intentamos crear una respuesta mientras otra seguía
                // activa (p. ej. una frase de espera). La ignoramos; el flujo se resincroniza
                // solo en el siguiente response.done.
                if (msg.error?.code === "conversation_already_has_active_response")
                    break;
                console.error("[REALTIME] Error:", JSON.stringify(msg.error));
                break;
            case "rate_limits.updated":
                break;
        }
    }
    // El fetch de la función terminó. Mete el resultado como function_call_output
    // (esto es seguro en cualquier momento). Luego decide cuándo hablarlo:
    //   - si el cliente interrumpió la espera → no hablar encima de él (el siguiente
    //     turno usará el resultado que ya quedó en contexto);
    //   - si todavía suena una frase de espera → diferir hasta su response.done;
    //   - si no hay nada sonando → hablar de inmediato.
    alResolverFuncion(callId, resultado) {
        this.funcionLentaPendiente = null;
        if (!this.ws || !this.conectado)
            return;
        this.ws.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
                type: "function_call_output",
                call_id: callId,
                output: JSON.stringify(resultado),
            },
        }));
        console.log(`[REALTIME] Resultado función listo (callId=${callId}):`, resultado);
        if (this.esperaInterrumpida) {
            this.esperaInterrumpida = false;
            return; // el cliente está hablando; no le ganamos el turno
        }
        if (this.respondiendo) {
            this.resultadoListoParaHablar = true; // hay una frase de espera sonando
            return;
        }
        this.crearRespuesta();
    }
    // Pide a la API que genere la respuesta hablada con el contexto actual.
    // Marca respondiendo=true de forma optimista para cerrar la ventana de carrera
    // entre el resultado del fetch y el fin de una frase de espera.
    crearRespuesta() {
        if (!this.ws || !this.conectado)
            return;
        this.respondiendo = true;
        this.ws.send(JSON.stringify({ type: "response.create" }));
    }
    // Hace que el agente diga una frase de espera con su propia voz mientras corre
    // el fetch. Es una respuesta fuera de banda (conversation:"none"): se oye pero
    // NO entra al historial ni rompe la adyacencia function_call → function_call_output.
    reproducirFraseEspera(nombreFuncion) {
        if (!this.ws || !this.conectado)
            return;
        const frase = this.fillersReproducidos === 0
            ? fraseEspera(nombreFuncion)
            : FRASE_ESPERA_REFUERZO;
        this.fillerActivo = true;
        this.fillersReproducidos++;
        this.respondiendo = true; // optimista: evita doble response.create simultáneo
        // Pequeña gracia para que un eco/ruido no cancele la frase apenas empieza.
        this.graceUntil = Date.now() + 600;
        this.ws.send(JSON.stringify({
            type: "response.create",
            response: {
                conversation: "none",
                output_modalities: ["audio"],
                instructions: `Di EXACTAMENTE esta frase en español mexicano, sin agregar ni cambiar nada, sin llamar a ninguna función: "${frase}"`,
                tool_choice: "none",
            },
        }));
        console.log(`[REALTIME] Frase de espera (${this.fillersReproducidos}/${MAX_FILLERS}): "${frase}"`);
    }
    enviarAudio(base64Audio) {
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
    setOnAudioDelta(callback) { this.onAudioDelta = callback; }
    setOnTranscript(callback) { this.onTranscript = callback; }
    setOnItemCreated(callback) { this.onItemCreated = callback; }
    setOnInterrupcion(callback) { this.onInterrupcion = callback; }
    setOnFunctionCall(callback) { this.onFunctionCall = callback; }
    cerrar() {
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch { }
            this.ws = null;
            this.conectado = false;
        }
    }
    get estaConectado() { return this.conectado; }
}
exports.OpenAIRealtime = OpenAIRealtime;
//# sourceMappingURL=realtime.js.map