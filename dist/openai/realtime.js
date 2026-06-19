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
// UNA sola frase de espera por situación. Se le pasa al modelo para que la diga
// con su propia voz Realtime (sin corte de voz). Cortas a propósito: entre menos
// audio suene, menos riesgo de que el eco/ruido la corte o se encime con el
// mensaje real.
function fraseEspera(nombre, args) {
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
// Nombre del "mark" que mandamos a Twilio al terminar de generar la frase de
// espera. Twilio nos lo devuelve cuando termina de REPRODUCIRLA (no solo de
// generarla), y recién entonces decimos el mensaje real — así no se enciman.
const MARK_FIN_FRASE = "fin_frase";
// Silencio (ms) tras el último fragmento de habla del cliente antes de que el
// agente responda. Sirve para AGRUPAR varios fragmentos cortos ("ok"… "ok"…) en
// una sola respuesta en vez de contestar a cada uno. Cada vez que el cliente
// (re)empieza a hablar, este temporizador se reinicia.
const DEBOUNCE_RESPUESTA_MS = 600;
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
    // === Frase de espera + sincronización con la reproducción real en Twilio ===
    // funcionLentaPendiente: nombre de la función cuyo fetch sigue en curso (o null).
    // funcionLentaArgs: args parseados de esa función (para elegir la frase correcta).
    // fillerActivo: true mientras se genera la frase de espera.
    // esperandoFinFrase: true tras pedir la frase, hasta que Twilio confirma (mark)
    //   que terminó de REPRODUCIRLA. Mientras tanto NO se dice el mensaje real ni se
    //   corta por eco → evita el "muy seguidas" y el "cortado".
    // resultadoPendiente: resultado del fetch ya listo (su item ya se mandó); falta
    //   que el agente lo diga cuando la frase de espera haya terminado de oírse.
    // esperaInterrumpida: el cliente habló durante la espera → no hablar encima de él.
    // markFraseTimeout: red de seguridad por si Twilio nunca devuelve el mark.
    funcionLentaPendiente = null;
    funcionLentaArgs = null;
    fillerActivo = false;
    esperandoFinFrase = false;
    resultadoPendiente = null;
    esperaInterrumpida = false;
    markFraseTimeout = null;
    // Callback para mandar un "mark" por el WebSocket de Twilio (lo conecta el
    // PipelineLlamada). Twilio lo devuelve cuando termina de reproducir el audio.
    onEnviarMark = null;
    // Debounce para agrupar la entrada del cliente en una sola respuesta. Se
    // reinicia cada vez que el cliente (re)empieza a hablar.
    respuestaTimer = null;
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
                        // "low": el VAD es más conservador para decidir que el cliente habló.
                        // Reduce las interrupciones falsas por eco/ruido que cortaban al agente
                        // a media frase. Cuesta un pelín de reactividad al barge-in real.
                        eagerness: "low",
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
                // El cliente (vuelve a) hablar → reinicia el debounce para AGRUPAR todo lo
                // que diga en una sola respuesta (no contestar fragmento por fragmento).
                this.cancelarDebounceRespuesta();
                // NO cancelar mientras se generan los argumentos de una función: cancelar
                // truncaría el JSON y la acción (p. ej. la reserva) se mandaría vacía.
                if (this.funcionActual)
                    break;
                // NO cortar la frase de espera mientras se está reproduciendo: es corta y
                // el cliente está esperando; cortarla por eco es justo lo que molestaba.
                if (this.esperandoFinFrase)
                    break;
                if (this.respondiendo && this.ws && this.conectado && Date.now() > this.graceUntil && !this.cancelacionEnCurso) {
                    this.cancelacionEnCurso = true;
                    if (this.onInterrupcion)
                        this.onInterrupcion();
                    this.ws.send(JSON.stringify({ type: "response.cancel" }));
                    console.log("[REALTIME] INTERRUPCIÓN → audio cortado + cancel enviado");
                }
                break;
            case "input_audio_buffer.speech_stopped":
                // El cliente terminó (por ahora). Espera un poco por si sigue hablando y
                // recién entonces responde UNA sola vez con todo lo que dijo.
                this.programarRespuestaUsuario();
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
                    // El cliente interrumpió: no encadenar ni hablar el resultado encima de él.
                    if (eraFiller || this.funcionLentaPendiente || this.resultadoPendiente || this.esperandoFinFrase) {
                        this.esperaInterrumpida = true;
                    }
                    this.funcionLentaPendiente = null;
                    this.funcionLentaArgs = null;
                    this.esperandoFinFrase = false;
                    this.resultadoPendiente = null;
                    if (this.markFraseTimeout) {
                        clearTimeout(this.markFraseTimeout);
                        this.markFraseTimeout = null;
                    }
                    break;
                }
                if (eraFiller) {
                    // La frase de espera terminó de GENERARSE. Pedimos a Twilio que avise
                    // cuando termine de REPRODUCIRLA (mark) y recién ahí decimos el resultado.
                    if (this.onEnviarMark && this.esperandoFinFrase) {
                        this.onEnviarMark(MARK_FIN_FRASE);
                        // Red de seguridad: si el mark nunca vuelve, proceder igual a los 6s.
                        if (this.markFraseTimeout)
                            clearTimeout(this.markFraseTimeout);
                        this.markFraseTimeout = setTimeout(() => {
                            this.markFraseTimeout = null;
                            this.esperandoFinFrase = false;
                            this.intentarHablarResultado();
                        }, 6000);
                    }
                    else {
                        this.esperandoFinFrase = false;
                        this.intentarHablarResultado();
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
                        this.esperandoFinFrase = false;
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
                    catch (e) {
                        console.warn(`[REALTIME] Args de ${name} no son JSON válido (posible truncado): ${argsStr}`);
                    }
                    // Guardamos los args para elegir la frase de espera correcta (p. ej.
                    // distinguir verificación de disponibilidad vs confirmación de pago).
                    if (this.funcionLentaPendiente === name)
                        this.funcionLentaArgs = args;
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
    // (esto es seguro en cualquier momento) y lo deja pendiente de hablar. El
    // momento exacto en que se dice lo decide intentarHablarResultado().
    alResolverFuncion(callId, resultado) {
        this.funcionLentaPendiente = null;
        this.funcionLentaArgs = null;
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
        this.resultadoPendiente = { callId, resultado };
        this.intentarHablarResultado();
    }
    // Dice el resultado del fetch SOLO cuando se cumplen TODAS las condiciones:
    //   - ya llegó el resultado;
    //   - la frase de espera terminó de REPRODUCIRSE (mark de Twilio) — no encimar;
    //   - no se está generando otra frase de espera;
    //   - no hay otra respuesta activa.
    // Si el cliente interrumpió la espera, descarta el habla (el item ya quedó en
    // contexto y el siguiente turno lo aprovechará).
    intentarHablarResultado() {
        if (!this.resultadoPendiente)
            return;
        if (this.esperaInterrumpida) {
            this.esperaInterrumpida = false;
            this.resultadoPendiente = null;
            return;
        }
        if (this.esperandoFinFrase)
            return; // Twilio aún reproduce la frase de espera
        if (this.fillerActivo)
            return; // la frase aún se está generando
        if (this.respondiendo)
            return; // otra respuesta sigue activa
        this.resultadoPendiente = null;
        this.crearRespuesta();
    }
    // Twilio terminó de reproducir el audio hasta el mark indicado.
    marcaReproducida(nombre) {
        if (nombre !== MARK_FIN_FRASE)
            return;
        if (this.markFraseTimeout) {
            clearTimeout(this.markFraseTimeout);
            this.markFraseTimeout = null;
        }
        this.esperandoFinFrase = false;
        this.intentarHablarResultado();
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
    cancelarDebounceRespuesta() {
        if (this.respuestaTimer) {
            clearTimeout(this.respuestaTimer);
            this.respuestaTimer = null;
        }
    }
    // Programa (con debounce) la respuesta del agente al cliente. Como el cliente
    // puede decir varias cosas seguidas, esperamos un breve silencio: si vuelve a
    // hablar antes, se reinicia y TODO se agrupa en una sola respuesta. No responde
    // si hay una función o frase de espera en curso (esas manejan su propia
    // respuesta) ni si ya hay otra respuesta activa.
    programarRespuestaUsuario() {
        this.cancelarDebounceRespuesta();
        this.respuestaTimer = setTimeout(() => {
            this.respuestaTimer = null;
            if (this.funcionActual || this.funcionLentaPendiente || this.esperandoFinFrase)
                return;
            if (this.respondiendo)
                return;
            this.crearRespuesta();
        }, DEBOUNCE_RESPUESTA_MS);
    }
    // Hace que el agente diga UNA frase de espera con su propia voz mientras corre
    // el fetch. Es una respuesta fuera de banda (conversation:"none"): se oye pero
    // NO entra al historial ni rompe la adyacencia function_call → function_call_output.
    reproducirFraseEspera(nombreFuncion, args) {
        if (!this.ws || !this.conectado)
            return;
        const frase = fraseEspera(nombreFuncion, args);
        this.fillerActivo = true;
        this.esperandoFinFrase = true; // esperaremos el mark de Twilio antes del resultado
        this.respondiendo = true; // optimista: evita doble response.create simultáneo
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
    setOnEnviarMark(callback) { this.onEnviarMark = callback; }
    cerrar() {
        if (this.markFraseTimeout) {
            clearTimeout(this.markFraseTimeout);
            this.markFraseTimeout = null;
        }
        this.cancelarDebounceRespuesta();
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