/** Lo que guardamos en `client_state`. Claves cortas: Telnyx limita el tamaño. */
export type EstadoTelnyx = 
/** Llamada entrante contestada por la IA. */
{
    k: "in";
    n: string;
    c: string;
    f: string;
}
/** Pierna saliente de una transferencia a humano. `a` = call_control_id del cliente. */
 | {
    k: "tr";
    a: string;
    nid: string;
}
/** Despedida: al terminar de hablar, colgar. */
 | {
    k: "colgar";
};
export declare function codificarEstado(estado: EstadoTelnyx): string;
export declare function decodificarEstado(b64: unknown): EstadoTelnyx | null;
/**
 * El número en E.164 con "+", que es como Odin lo guarda en
 * `config_voz.numero_twilio` (y con lo que `config-llamada` busca el negocio).
 * Telnyx ya manda "+52…", pero si llegara sin "+" la búsqueda fallaría en
 * silencio y la llamada se despediría como "no disponible".
 */
export declare function normalizarE164(numero: unknown): string;
/** Quién llama, sin "+", igual que el `From.replace("+","")` del lado Twilio. */
export declare function numeroLlamante(from: unknown): string;
/**
 * El equivalente del `ForwardedFrom` de Twilio. Cuando el dueño activa el
 * desvío (`**61*…`), Telcel/AT&T/Movistar mandan la llamada con una cabecera
 * SIP `Diversion` que trae el número que el cliente marcó originalmente, p.ej.
 *   <sip:+524611234567@10.0.0.1;user=phone>;reason=no-answer;counter=1
 *   <tel:+524611234567>;reason=unconditional
 * Telnyx la entrega en `payload.sip_headers` de `call.initiated`. Devolvemos los
 * dígitos SIN "+" (como Twilio entregaba ForwardedFrom ya limpio), o "" si no
 * vino desviada.
 */
export declare function numeroDeDiversion(sipHeaders: unknown): string;
/**
 * Tarifa de Telnyx para México (hoja pública, nov-2026), en USD por minuto:
 * entrada a número local + cargo de Voice API + audio en vivo al agente.
 * Se redondea al minuto por llamada, igual que el cálculo de Twilio, para que
 * el costo registrado sea conservador mientras no confirmemos el redondeo real.
 */
export declare const TARIFA_TELNYX_MX_USD: {
    readonly entradaLocal: 0.005;
    readonly entradaMovil: 0.009;
    readonly voiceApi: 0.002;
    readonly streaming: 0.0035;
};
export declare function costoTelefoniaTelnyxUsd(segundos: number, tipo?: "local" | "movil", 
/** false con el motor de Telnyx (Conversation Relay): no hay stream de audio nuestro. */
conStreaming?: boolean): number;
/**
 * Lo que responde `config-llamada?soloGate=1` y qué hacemos ANTES de contestar.
 * Twilio lograba "cero consumo" cambiando el webhook del número a un <Reject/>
 * cuando el agente estaba apagado. Con Telnyx el número no se reconfigura:
 * preguntamos a Odin en `call.initiated` y, si el agente o la línea están
 * apagados, rechazamos SIN contestar (ocupado, sin costo). Sin saldo sí se
 * contesta, para decirle al cliente que no podemos atenderlo — igual que Twilio.
 */
export type GateLlamada = {
    bloqueado?: boolean;
    motivo?: string;
    /** Voz elegida en el panel. Si es de Telnyx ("Telnyx.Ultra.…"), se contesta con su motor. */
    voz?: string;
    velocidadVoz?: number | null;
} | null;
export declare function debeRechazarSinContestar(gate: GateLlamada): boolean;
/** Milisegundos de una fecha ISO de Telnyx, o null. */
export declare function msDe(iso: unknown): number | null;
/** Segundos que habló el humano: desde que contestó hasta que colgó. */
export declare function segundosConHumano(contestoMs: number | null, colgoMs: number | null): number;
//# sourceMappingURL=eventos.d.ts.map