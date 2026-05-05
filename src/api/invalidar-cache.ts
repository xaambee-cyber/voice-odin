import { Request, Response } from "express";
import { invalidarCache } from "../utils/config-cache";

// Endpoint para que Odin notifique cambios (voz, conocimiento, servicios, etc.).
// Después de invalidar, la próxima llamada hace fetch fresh y popula cache nueva.
export function invalidarCacheHandler(req: Request, res: Response) {
  const numeroTwilio = req.body?.numeroTwilio || req.query?.numeroTwilio;
  const negocioId = req.body?.negocioId || req.query?.negocioId;

  invalidarCache(numeroTwilio, negocioId);
  console.log(`[CACHE] Invalidado — numeroTwilio: ${numeroTwilio || "?"}, negocioId: ${negocioId || "?"}`);

  res.json({ ok: true });
}
