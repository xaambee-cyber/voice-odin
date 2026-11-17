import type { HerramientaVoz } from "../openai/realtime";
export type TipoMotor = "openai" | "relay";
/** Consumo de la parte de IA de la llamada. Los campos de audio solo los llena OpenAI. */
export interface UsoMotor {
    audioIn: number;
    textIn: number;
    cachedAudioIn: number;
    cachedTextIn: number;
    audioOut: number;
    textOut: number;
    /** Tokens que se escribieron al caché (solo Claude los reporta aparte). */
    cacheWrite?: number;
    /** Caracteres que se mandaron a convertir en voz (TTS de Telnyx, se cobra por carácter). */
    caracteresTts?: number;
    /** Modelo que pensó (para el registro). */
    modelo?: string;
    /** USD de la IA (OpenAI Realtime o Claude). Sin telefonía. */
    costoUsd: number;
    /** ¿El agente alcanzó a decir algo? Sin eso Odin no cobra la llamada. */
    huboContacto: boolean;
}
/** Latencia por turno medida en el voice server (lo que pasa en nuestro lado). */
export interface ResumenLatencia {
    turnos: number;
    medianaMs: number | null;
    promedioMs: number | null;
    maximaMs: number | null;
    esperaMedianaMs: number | null;
    modeloMedianaMs: number | null;
    modeloTranscripcion: string;
}
export interface MotorVoz {
    setOnAudioDelta(callback: (base64Audio: string) => void): void;
    setOnEspera(callback: (activa: boolean) => void): void;
    setOnTranscript(callback: (texto: string, role: "user" | "assistant", itemId?: string) => void): void;
    setOnItemCreated(callback: (itemId: string) => void): void;
    setOnInterrupcion(callback: () => void): void;
    setOnFunctionCall(callback: (name: string, args: any, callId: string) => Promise<any>): void;
    setOnCaida(callback: (motivo: string) => void): void;
    setOnErrorOpenAI(callback: (detalle: string) => void): void;
    abrirConexion(): Promise<void>;
    configurarSesion(prompt: string, tools?: HerramientaVoz[], voz?: string, velocidad?: number | null): void;
    enviarAudio(base64Audio: string): void;
    cancelarRespuesta(): void;
    cerrar(): void;
    resumenUso(): UsoMotor;
    resumenLatencia(): ResumenLatencia;
}
/** Percentil 50 de una lista de milisegundos (null si está vacía). */
export declare function mediana(valores: number[]): number | null;
//# sourceMappingURL=motor.d.ts.map