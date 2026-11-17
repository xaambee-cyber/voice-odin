import { NextFunction, Request, Response } from "express";
export declare function urlMediaStream(): string;
export declare function firmaTwilioValida(firma: string | string[] | undefined, url: string, params?: Record<string, unknown>): boolean;
export declare function requerirFirmaTwilio(req: Request, res: Response, next: NextFunction): void;
export declare function handleIncomingCall(req: Request, res: Response): void;
/**
 * TwiML de una llamada SALIENTE de prueba (la crea `/api/llamada-prueba` con
 * `calls.create`). Es el mismo <Stream> de una entrante, con dos cambios: la
 * URL de respaldo va completa (no hay webhook del cual colgar una relativa) y
 * el parámetro `prueba` le dice al pipeline que es de prueba.
 */
export declare function twimlLlamadaSaliente(opts: {
    numeroTwilio: string;
    callerNumber: string;
    base: string;
}): string;
export declare function handleFallback(req: Request, res: Response): void;
//# sourceMappingURL=twiml.d.ts.map