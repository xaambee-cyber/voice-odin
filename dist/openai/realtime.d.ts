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