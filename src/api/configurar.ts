import { Request, Response } from "express";

// Almacén en memoria de configuraciones por negocio
// En producción esto podría ser Redis, pero para MVP memoria es suficiente
const configuraciones: Map<string, any> = new Map();

export function configurarNegocio(req: Request, res: Response) {
  const {
    negocioId,
    nombreAgente,
    personalidad,
    tonoAdicional,
    nombreNegocio,
    tipoNegocio,
    horario,
    direccion,
    telefono,
    conocimiento,
    habilidades,
  } = req.body;

  if (!negocioId) {
    return res.status(400).json({ error: "negocioId requerido" });
  }

  configuraciones.set(negocioId, {
    nombreAgente: nombreAgente || "Asistente",
    personalidad: personalidad || "amigable",
    tonoAdicional,
    nombreNegocio: nombreNegocio || "Negocio",
    tipoNegocio: tipoNegocio || "general",
    horario,
    direccion,
    telefono,
    conocimiento: conocimiento || "",
    habilidades: habilidades || "",
  });

  console.log(`[CONFIG] Negocio configurado: ${negocioId} (${nombreNegocio})`);
  res.json({ ok: true, negocioId });
}

export function obtenerConfig(negocioId: string) {
  return configuraciones.get(negocioId) || {
    nombreAgente: "Asistente",
    personalidad: "amigable",
    nombreNegocio: "Negocio",
    tipoNegocio: "general",
    conocimiento: "",
    habilidades: "",
  };
}

export function obtenerEstado(req: Request, res: Response) {
  const negocioId = req.params.negocioId;
  const tieneConfig = configuraciones.has(negocioId);

  res.json({
    negocioId,
    configurado: tieneConfig,
    activo: tieneConfig,
    servidor: "online",
  });
}

export function listarNegocios(req: Request, res: Response) {
  const lista = Array.from(configuraciones.keys());
  res.json({ negocios: lista, total: lista.length });
}
