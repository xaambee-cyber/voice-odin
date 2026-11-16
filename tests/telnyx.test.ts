import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  codificarEstado,
  costoTelefoniaTelnyxUsd,
  debeRechazarSinContestar,
  decodificarEstado,
  normalizarE164,
  numeroDeDiversion,
  numeroLlamante,
  segundosConHumano,
} from "../src/telnyx/eventos";
import { tokenStream, tokenStreamValido, verificarFirmaTelnyx } from "../src/telnyx/firma";
import { urlStreamTelnyx } from "../src/telnyx/webhook";

test("client_state: ida y vuelta, y uno ajeno no truena", () => {
  const e = codificarEstado({ k: "in", n: "+524611234567", c: "524619876543", f: "" });
  assert.deepEqual(decodificarEstado(e), { k: "in", n: "+524611234567", c: "524619876543", f: "" });
  assert.equal(decodificarEstado(Buffer.from("hola").toString("base64")), null);
  assert.equal(decodificarEstado("%%%no-es-base64"), null);
  assert.equal(decodificarEstado(undefined), null);
});

test("el número que recibe queda en E.164 con + (así lo busca config-llamada)", () => {
  assert.equal(normalizarE164("+524611234567"), "+524611234567");
  assert.equal(normalizarE164("524611234567"), "+524611234567");
  assert.equal(normalizarE164("sip:algo@telnyx"), "sip:algo@telnyx");
  assert.equal(normalizarE164(""), "");
});

test("quien llama va sin + (igual que From.replace('+','') de Twilio)", () => {
  assert.equal(numeroLlamante("+524619876543"), "524619876543");
  assert.equal(numeroLlamante("anonymous"), "anonymous");
});

test("Diversion = ForwardedFrom de Twilio (sucursal de origen y anti-rebote)", () => {
  assert.equal(
    numeroDeDiversion([{ name: "Diversion", value: "<sip:+524611234567@10.0.0.1;user=phone>;reason=no-answer;counter=1" }]),
    "524611234567",
  );
  assert.equal(numeroDeDiversion([{ name: "diversion", value: "<tel:+523411112222>;reason=unconditional" }]), "523411112222");
  // Desvíos encadenados: manda el más reciente (el primero), como Twilio.
  assert.equal(
    numeroDeDiversion([{ name: "Diversion", value: "<sip:+524610000001@a>;reason=no-answer, <sip:+524610000002@b>;reason=busy" }]),
    "524610000001",
  );
  assert.equal(numeroDeDiversion([{ name: "User-to-User", value: "abc" }]), "");
  assert.equal(numeroDeDiversion(undefined), "");
});

test("costo de telefonía Telnyx: 0.0105 USD por minuto local, redondeado al minuto", () => {
  assert.equal(costoTelefoniaTelnyxUsd(8), 0.0105);
  assert.equal(costoTelefoniaTelnyxUsd(60), 0.0105);
  assert.equal(costoTelefoniaTelnyxUsd(61), 0.021);
  assert.equal(costoTelefoniaTelnyxUsd(0), 0);
  assert.equal(costoTelefoniaTelnyxUsd(60, "movil"), 0.0145);
});

test("solo se rechaza sin contestar si el agente o la línea están apagados", () => {
  assert.equal(debeRechazarSinContestar({ bloqueado: true, motivo: "agente_apagado" }), true);
  assert.equal(debeRechazarSinContestar({ bloqueado: true, motivo: "linea_apagada" }), true);
  // Sin saldo se contesta para avisarle al cliente (igual que Twilio).
  assert.equal(debeRechazarSinContestar({ bloqueado: true, motivo: "sin_saldo" }), false);
  assert.equal(debeRechazarSinContestar({ bloqueado: false }), false);
  // Odin no respondió: se contesta.
  assert.equal(debeRechazarSinContestar(null), false);
});

test("tramo humano: de que contestó a que colgó; sin contestar = 0", () => {
  assert.equal(segundosConHumano(1_000, 91_000), 90);
  assert.equal(segundosConHumano(null, 91_000), 0);
  assert.equal(segundosConHumano(5_000, 1_000), 0);
});

test("firma ed25519 de Telnyx: válida, alterada, vieja y llave cruda de 32 bytes", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const llaveCruda = der.subarray(der.length - 32).toString("base64"); // como la da el portal
  const ahora = 1_800_000_000_000;
  const t = String(Math.floor(ahora / 1000));
  const cuerpo = JSON.stringify({ data: { event_type: "call.initiated" } });
  const firma = crypto.sign(null, Buffer.from(`${t}|${cuerpo}`), privateKey).toString("base64");

  assert.equal(verificarFirmaTelnyx(cuerpo, firma, t, llaveCruda, 300, ahora), true);
  assert.equal(verificarFirmaTelnyx(cuerpo + " ", firma, t, llaveCruda, 300, ahora), false);
  assert.equal(verificarFirmaTelnyx(cuerpo, firma, t, llaveCruda, 300, ahora + 10 * 60_000), false);
  assert.equal(verificarFirmaTelnyx(cuerpo, null, t, llaveCruda, 300, ahora), false);
  assert.equal(verificarFirmaTelnyx(cuerpo, firma, t, "", 300, ahora), false);
});

test("token del WebSocket: amarrado a la llamada y al secreto", () => {
  const tok = tokenStream("v3:llamada-1", "secreto");
  assert.equal(tokenStreamValido("v3:llamada-1", tok, "secreto"), true);
  assert.equal(tokenStreamValido("v3:llamada-2", tok, "secreto"), false);
  assert.equal(tokenStreamValido("v3:llamada-1", tok, "otro"), false);
  assert.equal(tokenStreamValido("v3:llamada-1", null, "secreto"), false);
});

test("la URL del stream es wss, va a /ws-telnyx y lleva la llamada y su token", () => {
  const url = new URL(urlStreamTelnyx("v3:abc"));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/ws-telnyx");
  assert.equal(url.searchParams.get("ccid"), "v3:abc");
  assert.equal(tokenStreamValido("v3:abc", url.searchParams.get("t")), true);
});
