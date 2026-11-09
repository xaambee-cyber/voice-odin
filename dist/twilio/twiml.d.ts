import { Request, Response } from "express";
export declare function urlMediaStream(): string;
export declare function firmaTwilioValida(firma: string | string[] | undefined, url: string, params?: Record<string, unknown>): boolean;
export declare function handleIncomingCall(req: Request, res: Response): void;
export declare function handleFallback(req: Request, res: Response): void;
//# sourceMappingURL=twiml.d.ts.map