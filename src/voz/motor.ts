import type { HerramientaVoz } from "../openai/realtime";

// ═══════════════════════════════════════════════════════════════════════════
// El "motor" de una llamada: quien escucha al cliente, piensa y habla.
//
// Hay dos y el PipelineLlamada no sabe cuál tiene enfrente:
//   - OpenAIRealtime (src/openai/realtime.ts): voz a voz con gpt-realtime. Es
//     el de siempre, para Twilio y para Telnyx con voces de OpenAI.
//   - MotorRelayTelnyx (src/telnyx/relay.ts): Telnyx transcribe y habla con sus
//     voces (Conversation Relay) y Claude piensa. Solo existe en líneas de
//     Telnyx con una voz de Telnyx elegida en el panel.
//
// Las herramientas (agendar, cancelar, transferir, motores…) NO viven en el
// motor: el motor solo avisa "el modelo pidió X" y el pipeline las ejecuta con
// manejarFuncion — el MISMO código para los dos. Así una regla de negocio
// nunca tiene dos versiones según el motor.
// ═══════════════════════════════════════════════════════════════════════════

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
export function mediana(valores: number[]): number | null {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const mitad = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[mitad] : Math.round((orden[mitad - 1] + orden[mitad]) / 2);
}
