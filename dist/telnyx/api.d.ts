export type ResultadoComando = {
    ok: boolean;
    status: number;
    error?: string;
};
/**
 * Contesta y abre el audio bidireccional hacia /ws-telnyx.
 *  - `stream_codec: PCMU` fuerza μ-law 8 kHz en lo que RECIBIMOS (si no, Telnyx
 *    manda el códec de la llamada, que puede ser G.722 o PCMA) — OpenAI está
 *    configurado en `audio/pcmu`, igual que con Twilio.
 *  - `stream_bidirectional_mode: rtp` + `PCMU`: lo que MANDAMOS son los mismos
 *    bytes μ-law que OpenAI entrega, sin convertir. Los sonidos pregenerados
 *    (tecleo, ambiente) también son μ-law y sirven tal cual.
 *  - `stream_track: inbound_track`: solo la voz del cliente, como Twilio.
 */
export declare function contestar(callControlId: string, opts: {
    streamUrl: string;
    clientState: string;
}): Promise<ResultadoComando>;
/**
 * Contesta con el motor de voz de TELNYX (Conversation Relay): Telnyx
 * transcribe y habla con sus voces; a nosotros solo nos llega texto por el
 * WebSocket de `relay.url`. No se abre el stream de audio de OpenAI.
 */
export declare function contestarConRelay(callControlId: string, opts: {
    relay: Record<string, unknown>;
    clientState: string;
}): Promise<ResultadoComando>;
/**
 * Enciende la limpieza de la voz del cliente (eco y voz baja; ver
 * `intentosSupresion`). Prueba cada combinación hasta que Telnyx acepte una.
 * Devuelve el motor que quedó, o null. Nunca lanza: sin limpieza la llamada
 * sigue igual que antes.
 */
export declare function limpiarAudio(callControlId: string, intentos: Record<string, unknown>[]): Promise<{
    motor: string | null;
    error?: string;
}>;
/** Termina Conversation Relay en la llamada (Telnyx cierra nuestro WebSocket). */
export declare function detenerRelay(callControlId: string): Promise<ResultadoComando>;
/**
 * Llamada SALIENTE (la de prueba del panel). `stream` o `relay` deciden el
 * motor igual que al contestar una entrante; los dos arrancan solos cuando la
 * persona contesta. `time_limit_secs` corta la llamada pase lo que pase.
 */
export declare function marcar(opts: {
    connectionId: string;
    to: string;
    from: string;
    timeLimitSecs: number;
    streamUrl?: string;
    relay?: Record<string, unknown>;
}): Promise<ResultadoComando & {
    callControlId?: string;
}>;
/** Rechaza SIN contestar: el cliente oye ocupado y no se cobra la llamada. */
export declare function rechazar(callControlId: string): Promise<ResultadoComando>;
export declare function colgar(callControlId: string): Promise<ResultadoComando>;
/**
 * Habla con la voz Polly.Mia (la misma del <Say> de Twilio) — solo para la
 * despedida cuando el agente no está disponible. `clientState` permite colgar
 * al terminar (`call.speak.ended`).
 */
export declare function hablar(callControlId: string, texto: string, clientState: string): Promise<ResultadoComando>;
/**
 * Pasa la llamada a un humano: Telnyx marca a `to` y, cuando contesta, lo une
 * con el cliente (que mientras oye el timbre: `early_media`). Es el <Dial
 * answerOnBridge> de Twilio. `from` debe ser nuestro número de Telnyx —el
 * equivalente del callerId— y `targetLegClientState` marca la pierna nueva
 * para medir cuánto habló el humano (se cobra aparte, como en Twilio).
 */
export declare function transferir(callControlId: string, opts: {
    to: string;
    from: string;
    timeoutSecs: number;
    targetLegClientState: string;
}): Promise<ResultadoComando>;
/** Cierra el audio hacia el agente (Telnyx manda "stop" al WebSocket). */
export declare function detenerStream(callControlId: string): Promise<ResultadoComando>;
//# sourceMappingURL=api.d.ts.map