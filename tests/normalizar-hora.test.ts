import test from "node:test";
import assert from "node:assert/strict";
import {
  anotacionHorariaParaAgente,
  horasExplicitasAmPm,
  normalizarArgumentosConHora,
} from "../src/utils/normalizar-hora";

test("anota 3 PM como 15:00 para Realtime", () => {
  assert.equal(horasExplicitasAmPm("quisiera a las 3 PM")[0]?.hora24, 15);
  assert.match(anotacionHorariaParaAgente("quisiera a las 3 p.m.") ?? "", /15:00/);
});

test("corrige la hora degradada en argumentos de cualquier herramienta", () => {
  const hora = horasExplicitasAmPm("3:30 PM")[0];
  const args = normalizarArgumentosConHora({
    fechaInicio: "2026-08-21T03:30:00",
    cambios: { hora: "03:30" },
    notas: "llegar 03:30",
  }, hora);
  assert.equal(args.fechaInicio, "2026-08-21T15:30:00");
  assert.equal(args.cambios.hora, "15:30");
  assert.equal(args.notas, "llegar 03:30");
});

test("12 AM y 12 PM no se intercambian", () => {
  assert.deepEqual(
    horasExplicitasAmPm("12 AM o 12 PM").map((h) => h.hora24),
    [0, 12],
  );
});
