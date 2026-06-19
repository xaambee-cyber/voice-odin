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
    constructor(systemPrompt: string, tools?: HerramientaVoz[], voz?: string);
    abrirConexion(): Promise<void>;
    configurarSesion(prompt: string, tools?: HerramientaVoz[], voz?: string): void;
    actualizarConfiguracion(prompt: string, tools?: HerramientaVoz[]): void;
    conectar(): Promise<void>;
    private handleMessage;
    enviarResultadoFuncion(callId: string, resultado: any): void;
    enviarAudio(base64Audio: string): void;
    cancelarRespuesta(): void;
    setOnAudioDelta(callback: (base64Audio: string) => void): void;
    setOnTranscript(callback: (texto: string, role: "user" | "assistant", itemId?: string) => void): void;
    setOnItemCreated(callback: (itemId: string) => void): void;
    setOnInterrupcion(callback: () => void): void;
    setOnFunctionCall(callback: (name: string, args: any, callId: string) => Promise<any>): void;
    cerrar(): void;
    get estaConectado(): boolean;
}
//# sourceMappingURL=realtime.d.ts.map