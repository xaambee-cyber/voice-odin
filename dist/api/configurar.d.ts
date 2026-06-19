import { Request, Response } from "express";
export declare function configurarNegocio(req: Request, res: Response): Response<any, Record<string, any>> | undefined;
export declare function obtenerConfig(negocioId: string): any;
export declare function obtenerEstado(req: Request, res: Response): void;
export declare function listarNegocios(req: Request, res: Response): void;
//# sourceMappingURL=configurar.d.ts.map