"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configurarNegocio = configurarNegocio;
exports.obtenerConfig = obtenerConfig;
exports.obtenerEstado = obtenerEstado;
exports.listarNegocios = listarNegocios;
// Almacén en memoria de configuraciones por negocio
// En producción esto podría ser Redis, pero para MVP memoria es suficiente
const configuraciones = new Map();
function configurarNegocio(req, res) {
    const { negocioId, nombreAgente, personalidad, tonoAdicional, nombreNegocio, tipoNegocio, horario, direccion, telefono, conocimiento, habilidades, } = req.body;
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
function obtenerConfig(negocioId) {
    return configuraciones.get(negocioId) || {
        nombreAgente: "Asistente",
        personalidad: "amigable",
        nombreNegocio: "Negocio",
        tipoNegocio: "general",
        conocimiento: "",
        habilidades: "",
    };
}
function obtenerEstado(req, res) {
    const negocioId = req.params.negocioId;
    const tieneConfig = configuraciones.has(negocioId);
    res.json({
        negocioId,
        configurado: tieneConfig,
        activo: tieneConfig,
        servidor: "online",
    });
}
function listarNegocios(req, res) {
    const lista = Array.from(configuraciones.keys());
    res.json({ negocios: lista, total: lista.length });
}
//# sourceMappingURL=configurar.js.map