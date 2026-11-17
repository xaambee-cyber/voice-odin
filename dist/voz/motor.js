"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mediana = mediana;
/** Percentil 50 de una lista de milisegundos (null si está vacía). */
function mediana(valores) {
    if (valores.length === 0)
        return null;
    const orden = [...valores].sort((a, b) => a - b);
    const mitad = Math.floor(orden.length / 2);
    return orden.length % 2 ? orden[mitad] : Math.round((orden[mitad - 1] + orden[mitad]) / 2);
}
//# sourceMappingURL=motor.js.map