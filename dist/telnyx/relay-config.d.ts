/** Voces de gpt-realtime que acepta el motor de OpenAI. */
export declare const VOCES_OPENAI: Set<string>;
/**
 * ¿Es una voz de Telnyx? ("Telnyx.Ultra.<uuid>", "Telnyx.KokoroTTS.ef_dora"…).
 * Es lo que decide el motor: una línea de Telnyx con voz de Telnyx usa
 * Conversation Relay; con voz de OpenAI, el motor de siempre.
 */
export declare function esVozTelnyx(voz: unknown): voz is string;
/**
 * La voz que puede usar el motor de OpenAI. Si el dueño eligió una de Telnyx
 * pero la llamada entró por Twilio (o por el motor de OpenAI), se usa Marin: un
 * nombre que OpenAI no conoce tumbaría la sesión y el cliente oiría el aviso de
 * "no disponible".
 */
export declare function vozParaOpenAI(voz: unknown): string;
/** Velocidad válida para las voces Ultra (0.6–1.5). null = la de la voz. */
export declare function velocidadTelnyx(v: unknown): number | null;
/**
 * Reconocimiento de voz. Default: Deepgram **Flux multilenguaje** en español,
 * que trae su propio detector de fin de turno y avisa ANTES del texto final
 * ("eagerEndOfTurn") — con eso empezamos a pensar la respuesta mientras el
 * cliente termina la frase. Nova-3 queda como plan B por env (VOZ_RELAY_STT).
 */
export declare function configTranscripcion(modelo?: string): {
    transcription_engine: "Deepgram";
    transcription_engine_config: Record<string, unknown>;
};
export type ParametrosRelay = Record<string, string>;
/**
 * El `conversation_relay_config` que va en el `answer` (entrantes) o en el
 * `dial` (llamada de prueba). `custom_parameters` regresa tal cual en el frame
 * `setup` del WebSocket: ahí viajan el número del negocio, quién llama y la
 * sucursal de desvío, igual que el client_state del motor de OpenAI.
 */
export declare function configRelay(opts: {
    url: string;
    voz: string;
    velocidad?: unknown;
    parametros: ParametrosRelay;
}): Record<string, unknown>;
export declare const TARIFA_RELAY_USD: {
    readonly relayPorMinuto: 0.05;
    readonly ttsUltraPorCaracter: 0.000032;
    readonly sttPorMinuto: 0.0074;
};
export declare function costoRelayUsd(segundos: number, caracteresTts: number): number;
/**
 * Limpia lo que el modelo escribe antes de mandarlo al TTS: markdown, emojis y
 * acotaciones entre corchetes se leerían en voz alta ("asterisco asterisco").
 * Se aplica por fragmento, así que no puede depender de ver la frase completa.
 */
export declare function textoParaVoz(fragmento: string): string;
/** Normaliza para comparar el texto "temprano" con el final (eager vs final). */
export declare function normalizarParaComparar(texto: string): string;
/** ¿El final dice lo mismo que el temprano? Entonces la respuesta que ya preparamos sirve. */
export declare function mismoTurno(temprano: string, final: string): boolean;
/** Milisegundos aproximados que tarda en decirse un texto (≈14 caracteres por segundo). */
export declare function msParaDecir(texto: string): number;
//# sourceMappingURL=relay-config.d.ts.map