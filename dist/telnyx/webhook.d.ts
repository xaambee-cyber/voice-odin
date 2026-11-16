import type { Request, Response } from "express";
import { type TransferenciaActiva } from "../api/transferencias";
/** Ruta del WebSocket de audio, con el token de esta llamada. */
export declare function urlStreamTelnyx(callControlId: string): string;
/** Despide con voz y cuelga al terminar; si Telnyx no puede hablar, cuelga ya. */
export declare function despedirYColgar(callControlId: string): Promise<void>;
export declare function purgarContestosViejos(): void;
export type AlTerminarTransferencia = (t: TransferenciaActiva, duracionSegundos: number, estado: string) => Promise<void>;
export declare function crearWebhookTelnyx(alTerminarTransferencia: AlTerminarTransferencia): (req: Request, res: Response) => void;
//# sourceMappingURL=webhook.d.ts.map