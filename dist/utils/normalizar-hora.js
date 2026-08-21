"use strict";
// Contrato horario compartido por todos los motores de voz. El transcript se
// conserva tal cual; esta capa agrega una equivalencia interna y, como última
// red, corrige argumentos de herramientas que hayan degradado 3 PM a 03:00.
Object.defineProperty(exports, "__esModule", { value: true });
exports.REGLA_NORMALIZACION_HORARIA = exports.PREFIJO_ANOTACION_HORARIA = void 0;
exports.horasExplicitasAmPm = horasExplicitasAmPm;
exports.anotacionHorariaParaAgente = anotacionHorariaParaAgente;
exports.esAnotacionHoraria = esAnotacionHoraria;
exports.ultimaHoraExplicita = ultimaHoraExplicita;
exports.normalizarArgumentosConHora = normalizarArgumentosConHora;
exports.PREFIJO_ANOTACION_HORARIA = "[NORMALIZACIÓN HORARIA DEL SISTEMA:";
exports.REGLA_NORMALIZACION_HORARIA = "HORA EXPLÍCITA DEL CLIENTE: un sufijo AM/PM es autoritativo. " +
    "3 PM, 3pm y 3 p.m. significan exactamente 15:00; 3 AM significa 03:00; " +
    "12 AM significa 00:00 y 12 PM significa 12:00. Usa 24 horas en argumentos de herramientas " +
    "y formato de 12 horas al hablar con el cliente. Nunca cambies una hora explícita para hacerla caber en el horario.";
const NUMERO_PALABRA = {
    una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
    siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
};
function a24(hora12, meridiano) {
    const base = hora12 % 12;
    return meridiano.toLowerCase() === "p" ? base + 12 : base;
}
function horasExplicitasAmPm(texto) {
    const halladas = [];
    const numerica = /(^|[^\p{L}\p{N}])((?:0?[1-9]|1[0-2]))(?:\s*:\s*([0-5]\d))?\s*([ap])\s*\.?\s*m\s*\.?(?=$|[^\p{L}\p{N}])/giu;
    const palabras = /(^|[^\p{L}\p{N}])(una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:\s+y\s+(cuarto|media))?\s*([ap])\s*\.?\s*m\s*\.?(?=$|[^\p{L}\p{N}])/giu;
    for (const match of texto.matchAll(numerica)) {
        const hora12 = Number(match[2]);
        const minuto = match[3] ? Number(match[3]) : 0;
        halladas.push({
            original: match[0].slice(match[1].length).trim(),
            hora12, minuto, hora24: a24(hora12, match[4]),
            indice: (match.index ?? 0) + match[1].length,
        });
    }
    for (const match of texto.matchAll(palabras)) {
        const hora12 = NUMERO_PALABRA[match[2].toLowerCase()];
        const minuto = match[3]?.toLowerCase() === "media" ? 30 : match[3] ? 15 : 0;
        halladas.push({
            original: match[0].slice(match[1].length).trim(),
            hora12, minuto, hora24: a24(hora12, match[4]),
            indice: (match.index ?? 0) + match[1].length,
        });
    }
    return halladas
        .sort((a, b) => a.indice - b.indice)
        .map(({ original, hora12, minuto, hora24 }) => ({ original, hora12, minuto, hora24 }));
}
function anotacionHorariaParaAgente(texto) {
    const horas = horasExplicitasAmPm(texto);
    if (horas.length === 0)
        return null;
    return `${exports.PREFIJO_ANOTACION_HORARIA} ${horas.map((h) => `"${h.original}" = ${String(h.hora24).padStart(2, "0")}:${String(h.minuto).padStart(2, "0")}`).join("; ")}. Estas equivalencias son autoritativas para todas las herramientas.]`;
}
function esAnotacionHoraria(texto) {
    return typeof texto === "string" && texto.startsWith(exports.PREFIJO_ANOTACION_HORARIA);
}
/** Última hora explícita del turno: es la que normalmente alimenta la función. */
function ultimaHoraExplicita(texto) {
    const horas = horasExplicitasAmPm(texto);
    return horas[horas.length - 1] ?? null;
}
/**
 * Red final para herramientas. Solo toca campos con semántica horaria y solo
 * cuando coinciden hora Y minuto con la lectura errónea de 12 horas.
 */
function normalizarArgumentosConHora(args, hora) {
    if (!hora || args == null)
        return args;
    const minuto = String(hora.minuto).padStart(2, "0");
    const correcta = `${String(hora.hora24).padStart(2, "0")}:${minuto}`;
    const erronea = new RegExp(`(^|T|\\s)0?${hora.hora12}:${minuto}(?=(:\\d{2})?($|[Z+\\-\\s]))`, "g");
    const recorrer = (valor, clave = "") => {
        if (typeof valor === "string") {
            return /fecha|hora|inicio|fin|cuando/i.test(clave)
                ? valor.replace(erronea, (_todo, prefijo) => `${prefijo}${correcta}`)
                : valor;
        }
        if (Array.isArray(valor))
            return valor.map((item) => recorrer(item, clave));
        if (valor && typeof valor === "object") {
            return Object.fromEntries(Object.entries(valor)
                .map(([k, v]) => [k, recorrer(v, k)]));
        }
        return valor;
    };
    return recorrer(args);
}
//# sourceMappingURL=normalizar-hora.js.map