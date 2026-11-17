import type { Request, Response } from "express";
import { type TransferenciaActiva } from "../api/transferencias";
import { type DatosSaliente } from "./firma";
/** Ruta del WebSocket de audio, con el token de esta llamada. */
export declare function urlStreamTelnyx(callControlId: string): string;
/** Ruta del WebSocket del motor de Telnyx (Conversation Relay), con el mismo token. */
export declare function urlRelayTelnyx(callControlId: string): string;
/** Igual, para una llamada saliente (de prueba): firma número y destino en vez del ccid. */
export declare function urlSalienteTelnyx(ruta: "ws-telnyx" | "relay-telnyx", firmado: {
    pr: string;
    t: string;
}): string;
/** Lo que el pipeline necesita saber de la llamada, en `custom_parameters` del relay. */
export declare function parametrosRelay(datos: DatosSaliente & {
    f?: string;
    prueba?: boolean;
}): Record<string, string>;
/** Despide con voz y cuelga al terminar; si Telnyx no puede hablar, cuelga ya. */
export declare function despedirYColgar(callControlId: string): Promise<void>;
export declare function purgarContestosViejos(): void;
export type AlTerminarTransferencia = (t: TransferenciaActiva, duracionSegundos: number, estado: string) => Promise<void>;
export declare function crearWebhookTelnyx(alTerminarTransferencia: AlTerminarTransferencia): (req: Request, res: Response) => void;
//# sourceMappingURL=webhook.d.ts.map