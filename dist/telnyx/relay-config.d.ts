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
export type AjustesRelay = {
    velocidad: number;
    idioma: "es" | "en" | "auto";
    finDeTurno: "rapido" | "normal" | "paciente";
    interrupciones: boolean;
    reconocimiento: "flux" | "nova3";
    cerebro: "rapido" | "listo";
    pensar: boolean;
    teclado: boolean;
    palabrasClave: string[];
};
export declare const AJUSTES_RELAY_DEFAULT: AjustesRelay;
export declare function normalizarAjustesRelay(raw: unknown): AjustesRelay;
/**
 * Reconocimiento de voz. Default: Deepgram **Flux multilenguaje**, que trae su
 * propio detector de fin de turno y avisa ANTES del texto final
 * ("eagerEndOfTurn") — con eso empezamos a pensar la respuesta mientras el
 * cliente termina la frase. Nova-3 es el plan B (ajuste "reconocimiento").
 * Las palabras clave (nombres del negocio, productos) van como `keyterms`.
 */
export declare function configTranscripcion(ajustes?: AjustesRelay): {
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
    /** Ajustes del panel (ya normalizados o crudos: aquí se acotan). */
    ajustes?: unknown;
}): Record<string, unknown>;
export declare function intentosSupresion(env?: Record<string, string | undefined>): Record<string, unknown>[];
export declare const TARIFA_RELAY_USD: {
    readonly relayPorMinuto: 0.05;
    readonly ttsUltraPorCaracter: 0.000032;
    readonly sttPorMinuto: 0.0074;
    /** Limpieza de la voz del cliente (ai-coustics), si quedó encendida. */
    readonly supresionPorMinuto: 0.003;
};
export declare function costoRelayUsd(segundos: number, caracteresTts: number, supresion?: boolean): number;
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
/**
 * ¿Lo que "dijo el cliente" es la voz del propio agente regresando por la
 * línea? El eco repite las palabras del agente EN ORDEN y llega mientras habla
 * o justo al terminar.
 *  - `hablando`: el agente seguía hablando (o Telnyx lo acababa de callar).
 *    Basta con 3 palabras suyas en orden, o con 1–2 si son el PRINCIPIO de lo
 *    que dijo (el eco de "Buenas noches" llega mientras suena el resto).
 *  - `cola`: ya había terminado hace un instante. Ahí el cliente ya puede estar
 *    contestando, y contestar una pregunta de opciones repite sus palabras
 *    ("¿martes o jueves?" → "El martes"), así que se exige más: 3+ palabras y
 *    casi todas en orden.
 * Si el cliente dice una palabra de respuesta ("sí", "no", "claro") que el
 * agente no dijo, nunca es eco.
 */
export declare function pareceEco(cliente: string, agente: string, modo?: "hablando" | "cola"): boolean;
/** Milisegundos aproximados que tarda en decirse un texto (≈14 caracteres por segundo). */
export declare function msParaDecir(texto: string): number;
//# sourceMappingURL=relay-config.d.ts.map