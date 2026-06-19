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
    private respondiendo;
    private graceUntil;
    private saludoEnviado;
    private cancelacionEnCurso;
    private funcionActual;
    private funcionLentaPendiente;
    private funcionLentaArgs;
    private fillerActivo;
    private esperandoFinFrase;
    private resultadoPendiente;
    private esperaInterrumpida;
    private markFraseTimeout;
    private onEnviarMark;
    private respuestaTimer;
    constructor(systemPrompt: string, tools?: HerramientaVoz[], voz?: string);
    abrirConexion(): Promise<void>;
    configurarSesion(prompt: string, tools?: HerramientaVoz[], voz?: string): void;
    actualizarConfiguracion(prompt: string, tools?: HerramientaVoz[]): void;
    conectar(): Promise<void>;
    private handleMessage;
    private alResolverFuncion;
    private intentarHablarResultado;
    marcaReproducida(nombre: string): void;
    private crearRespuesta;
    private cancelarDebounceRespuesta;
    private programarRespuestaUsuario;
    private reproducirFraseEspera;
    enviarAudio(base64Audio: string): void;
    cancelarRespuesta(): void;
    setOnAudioDelta(callback: (base64Audio: string) => void): void;
    setOnTranscript(callback: (texto: string, role: "user" | "assistant", itemId?: string) => void): void;
    setOnItemCreated(callback: (itemId: string) => void): void;
    setOnInterrupcion(callback: () => void): void;
    setOnFunctionCall(callback: (name: string, args: any, callId: string) => Promise<any>): void;
    setOnEnviarMark(callback: (nombre: string) => void): void;
    cerrar(): void;
    get estaConectado(): boolean;
}
//# sourceMappingURL=realtime.d.ts.map