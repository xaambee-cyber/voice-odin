export interface HerramientaVoz {
    type: "function";
    name: string;
    description: string;
    parameters: any;
}
export declare class OpenAIRealtime {
    private ws;
    private onAudioDelta;
    private onTranscript;
    private onItemCreated;
    private onInterrupcion;
    private onFunctionCall;
    private onCaida;
    private onErrorOpenAI;
    private conectado;
    private systemPrompt;
    private tools;
    private voz;
    /** Velocidad de la voz (0.25–1.5, 1.0 default). Se fija al configurar la sesión. */
    private velocidad;
    /** Con qué modelo quedó la sesión (preferido o fallback) — para logs. */
    private modeloActivo;
    private respondiendo;
    private graceUntil;
    private saludoEnviado;
    private cancelacionEnCurso;
    /** Espera SILENCIOSA: la frase de espera ya terminó y el fetch sigue en
     *  curso. El pipeline usa este hook para reproducir el tecleo. */
    private onEspera;
    private uso;
    private funcionActual;
    private funcionLentaPendiente;
    private funcionLentaArgs;
    private fillerActivo;
    private resultadoPendiente;
    private esperaInterrumpida;
    private respuestaTimer;
    /** Esperamos brevemente el transcript para poder anotar AM/PM antes de responder. */
    private esperandoTranscripcionHasta;
    /** Última hora explícita: red determinista para los argumentos de funciones. */
    private horaExplicitaTurno;
    private ultimaActividadRespuesta;
    constructor(systemPrompt: string, tools?: HerramientaVoz[], voz?: string);
    abrirConexion(): Promise<void>;
    private conectarModelo;
    configurarSesion(prompt: string, tools?: HerramientaVoz[], voz?: string, velocidad?: number | null): void;
    actualizarConfiguracion(prompt: string, tools?: HerramientaVoz[]): void;
    conectar(): Promise<void>;
    private handleMessage;
    private alResolverFuncion;
    private intentarHablarResultado;
    private crearRespuesta;
    private cancelarDebounceRespuesta;
    private programarRespuestaUsuario;
    private intentarRespuestaUsuarioProgramada;
    private reproducirFraseEspera;
    enviarAudio(base64Audio: string): void;
    cancelarRespuesta(): void;
    setOnAudioDelta(callback: (base64Audio: string) => void): void;
    /** true = arranca espera silenciosa (fetch en curso, nadie hablando);
     *  false = terminó (va a hablar alguien o el cliente interrumpió). */
    setOnEspera(callback: (activa: boolean) => void): void;
    setOnTranscript(callback: (texto: string, role: "user" | "assistant", itemId?: string) => void): void;
    setOnItemCreated(callback: (itemId: string) => void): void;
    setOnInterrupcion(callback: () => void): void;
    setOnFunctionCall(callback: (name: string, args: any, callId: string) => Promise<any>): void;
    /** OpenAI cerró la sesión a media llamada sin que nosotros la cerráramos
     *  (sin saldo, error del servidor). El pipeline decide qué oye el cliente. */
    setOnCaida(callback: (motivo: string) => void): void;
    /** Todo error que reporta OpenAI (evento "error", respuesta fallida, cierre).
     *  El pipeline decide si es falta de crédito y avisa al equipo. */
    setOnErrorOpenAI(callback: (detalle: string) => void): void;
    private acumularUso;
    costoUsdOpenAI(): number;
    resumenUso(): {
        costoUsd: number;
        audioIn: number;
        textIn: number;
        cachedAudioIn: number;
        cachedTextIn: number;
        audioOut: number;
        textOut: number;
    };
    cerrar(): void;
    get estaConectado(): boolean;
}
//# sourceMappingURL=realtime.d.ts.map