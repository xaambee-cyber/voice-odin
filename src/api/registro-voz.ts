import { Request, Response } from "express";

// Mini-registro en memoria de la voz seleccionada por cada número Twilio.
// Se popula por push desde Odin cada vez que el dueño cambia la voz en el
// panel. Es lo único que necesitamos asegurar que llegue a tiempo al saludo,
// porque el race fetch a Vercel a veces es más lento que el saludo.
//
// No tiene TTL: una vez que Odin pushea, la voz queda en memoria hasta el
// próximo cambio o hasta que el contenedor se reinicie. Si reinicia, la
// próxima llamada usará default (marin) hasta que Odin vuelva a pushear,
// lo cual ocurre automáticamente cuando el dueño guarda voz.

const registro = new Map<string, string>();

export function obtenerVozPorNumero(numeroTwilio: string): string | null {
  return registro.get(numeroTwilio) || null;
}

export function setVozHandler(req: Request, res: Response) {
  const numeroTwilio = req.body?.numeroTwilio;
  const voz = req.body?.voz;

  if (!numeroTwilio || !voz) {
    return res.status(400).json({ error: "numeroTwilio y voz requeridos" });
  }

  registro.set(numeroTwilio, voz);
  console.log(`[REGISTRO-VOZ] ${numeroTwilio} → ${voz}`);

  res.json({ ok: true });
}
