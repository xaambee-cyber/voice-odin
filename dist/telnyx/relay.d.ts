import Anthropic from "@anthropic-ai/sdk";
import WebSocket from "ws";
import { type HerramientaVoz } from "../openai/realtime";
import { type MotorVoz, type ResumenLatencia, type UsoMotor } from "../voz/motor";
import { type AjustesRelay } from "./relay-config";
/**
 * Modelo que piensa. Haiku 5.5 por la meta de ~1 s por turno: es el de menor
 * tiempo al primer token y en una llamada cada décima de segundo se oye.
 * Para probar otro sin tocar código: VOZ_RELAY_MODELO=claude-sonnet-5-5.
 */
export declare const MODELO_RELAY: string;
/** Cerebro "más listo" del panel: mejor razonamiento, ~+0.3–0.5 s por turno. */
export declare const MODELO_RELAY_LISTO: string;
export declare function relayDisponible(ahora?: number): boolean;
export declare function motivoRelayNoDisponible(): string;
/** Claude no puede pensar (llave/crédito): las siguientes llamadas van por OpenAI un rato. */
export declare function marcarRelayCaido(motivo: string, ahora?: number): void;
/** Solo pruebas. */
export declare function _reiniciarRelayCaido(): void;
export declare function costoClaudeUsd(modelo: string, uso: {
    entrada: number;
    salida: number;
    cacheLeido: number;
    cacheEscrito: number;
}): number;
/**
 * Parámetros de razonamiento por modelo. En una llamada no hay tiempo para
 * "pensar" antes de hablar: se apaga donde se puede y el esfuerzo va bajo
 * (respuestas cortas, menos preámbulo). Cada familia lo acepta distinto:
 *  - Haiku 5.5: `disabled` se acepta con esfuerzo high o menor.
 *  - Sonnet 5.5: `disabled` da 400; lo equivalente es `between_tools`.
 *  - Opus 5.5: no se puede apagar; solo se baja el esfuerzo.
 *  - Haiku 4.5 / Sonnet 4.6: sin `thinking` no piensa; no aceptan `effort`… salvo Sonnet 4.6.
 */
export declare function parametrosRazonamiento(modelo: string, pensar?: boolean): Record<string, unknown>;
/** Las herramientas del motor de OpenAI, en el formato de Claude (mismo esquema JSON). */
export declare function herramientasClaude(tools: HerramientaVoz[]): Anthropic.Tool[];
/**
 * El prompt del negocio partido en dos bloques para el caché: lo estable
 * (reglas, catálogo, horarios) y el contexto de ESTA llamada (fecha, citas de
 * quien llama). El primero se reutiliza entre llamadas del mismo negocio.
 * Las reglas de voz van AL FINAL, después del contexto: es lo último que lee el
 * modelo antes de hablar y donde más pesan (son cortas; no importa que no se
 * reutilicen entre llamadas).
 */
/** Regla de idioma según el ajuste del panel (las instrucciones siguen en español). */
export declare function reglaIdioma(idioma: AjustesRelay["idioma"]): string;
export declare function bloquesSistema(prompt: string, idioma?: AjustesRelay["idioma"]): Anthropic.TextBlockParam[];
export declare class MotorRelayTelnyx implements MotorVoz {
    private ws;
    private cliente;
    private sistema;
    private herramientas;
    private mensajes;
    private cadena;
    private contador;
    private turnoVivo;
    private cerrado;
    private saludoPedido;
    /** Ajustes del panel para ESTA llamada (cerebro, pensar, idioma, reconocimiento). */
    private modelo;
    private pensar;
    private ajustes;
    private errores;
    private colgarPedido;
    /** Telnyx acepta `token: ""` para cerrar el turno; si algún día no, se manda " ". */
    private tokenVacioOk;
    /** Cuándo termina (aprox.) de hablar la voz lo que ya le mandamos. */
    private finHablaMs;
    private horaExplicita;
    private teclas;
    private teclasTimer;
    private uso;
    private latencias;
    private aprovechados;
    private descartados;
    private onTranscript;
    private onItemCreated;
    private onInterrupcion;
    private onFunctionCall;
    private onCaida;
    private onErrorModelo;
    /** `cliente` solo se inyecta en pruebas (un Claude falso que no cuesta). */
    constructor(ws: WebSocket, opciones?: {
        cliente?: Anthropic;
    });
    setOnAudioDelta(): void;
    setOnEspera(): void;
    setOnTranscript(cb: (texto: string, role: "user" | "assistant", itemId?: string) => void): void;
    setOnItemCreated(cb: (itemId: string) => void): void;
    setOnInterrupcion(cb: () => void): void;
    setOnFunctionCall(cb: (name: string, args: any, callId: string) => Promise<any>): void;
    setOnCaida(cb: (motivo: string) => void): void;
    setOnErrorOpenAI(cb: (detalle: string) => void): void;
    abrirConexion(): Promise<void>;
    configurarSesion(prompt: string, tools?: HerramientaVoz[]): void;
    enviarAudio(): void;
    cancelarRespuesta(): void;
    cerrar(): void;
    resumenUso(): UsoMotor;
    resumenLatencia(): ResumenLatencia;
    /**
     * Ajustes del panel (Empleado → "Ajustes de la voz") para esta llamada. Lo
     * llama el pipeline con la config de Odin ANTES de configurarSesion. Lo que
     * toca a Telnyx (voz, velocidad, reconocimiento, interrupciones) ya se fijó
     * al contestar; aquí va lo que decide el que piensa.
     */
    aplicarAjustes(raw: unknown): void;
    private etiquetaStt;
    /** Cuánto le falta (aprox.) a la voz para terminar lo que ya se le mandó. */
    msHablaPendiente(): number;
    /** Decir un texto fijo (despedida) fuera de la conversación del modelo. */
    decir(texto: string): void;
    /** El modelo pidió colgar: no se encadena otra respuesta después. */
    marcarColgado(): void;
    /** Un frame del WebSocket de Telnyx (el `setup` ya lo consumió index.ts). */
    recibirFrame(msg: any): void;
    private alFinTemprano;
    private alReanudar;
    private alTextoFinal;
    private alInterrumpir;
    private alTecla;
    private iniciarTurno;
    /** El texto final confirmó lo que ya estábamos preparando: se suelta. */
    private confirmar;
    private descartar;
    private abortar;
    /** Mete al historial lo que dijo el cliente (una sola vez por turno). */
    private comprometerUsuario;
    /** Agrega al historial; dos del mismo rol seguidos se funden en uno. */
    private agregarMensaje;
    private recortarUltimaRespuesta;
    private correrTurno;
    private ejecutar;
    private alFallarModelo;
    /** Abortado a media respuesta: el historial guarda lo que sí se alcanzó a decir. */
    private cerrarAbortado;
    private escribir;
    private enviarTexto;
    private cerrarTexto;
    private registrarLatencia;
    private contarUso;
    /** Una respuesta abortada también se cobra: lo que alcanzó a leer y escribir. */
    private contarUsoParcial;
}
//# sourceMappingURL=relay.d.ts.map