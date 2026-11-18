# voice-odin (odin-voice)

Servidor de **voz** de Xambee: contesta llamadas telefónicas por Twilio y las
atiende con un agente de IA conversacional en tiempo real. Es el codebase
separado que **Odin** (la plataforma principal) referencia como `odin-voice`
en su propio `AGENTS.md` — Odin es el panel/backend de negocio; este repo es
solo el servidor de llamadas.

## Qué hace

1. Twilio recibe una llamada y pega a `/twiml` → este server responde TwiML
   que abre un WebSocket bidireccional de audio (`/ws`) hacia Twilio Media
   Streams (`src/twilio/twiml.ts`).
2. Por ese WebSocket, el audio se puentea en vivo contra la **Realtime API de
   OpenAI** (`gpt-realtime`, modelo `marin` por default) — un solo modelo hace
   STT + conversación + TTS, sin pasos intermedios (`src/openai/realtime.ts`).
3. `src/pipeline/llamada.ts` (`PipelineLlamada`) es el orquestador: arma el
   system prompt en español mexicano a partir de la configuración del negocio,
   define las **tools** que el modelo puede invocar y las ejecuta llamando de
   vuelta a **Odin** (la app Next.js) por HTTP con el secreto compartido
   `VOICE_SERVER_SECRET`.

   Las tools son de **tres clases**, y la diferencia importa:

   - **Fijas**, escritas en este repo: `consultar_disponibilidad`,
     `agendar_cita`, `cancelar_cita`, `reagendar_cita`, `solicitar_reserva`,
     `crear_pedido`, `escalar_humano`, `registrar_pregunta`, `colgar_llamada`,
     `enviar_ubicacion`. Cada una tiene su `case` en `manejarFuncion` y su
     endpoint propio en Odin. Cuando Odin manda `mensaje` en una respuesta
     (ocupado, fuera de horario, servicio inexistente), se dice ese texto: es el
     mismo que WhatsApp. Un error que no es del horario NO se le cuenta al
     cliente como "intenta con otro horario".
   - **De motor** (CREAR), que llegan como DATOS en `accionesMotor` de
     `config-llamada` (`reservar_mesa`, `registrar_orden`,
     `registrar_prospecto`, `registrar_viaje`, `registrar_membresia`,
     `apartar_lugares`). No hay un `case` por cada una: se registran solas a
     partir del esquema que manda Odin y todas se ejecutan contra
     `/api/voice/accion-motor`, que valida, persiste y avisa al dueño con el
     MISMO núcleo que WhatsApp y Meta.
   - **De ciclo de vida** (CONSULTAR / ACTUALIZAR / CANCELAR):
     `consultar_operacion`, `modificar_operacion` y `cancelar_operacion`. Son
     TRES genéricas, no tres por operación —un negocio con cinco motores tendría
     quince funciones y el modelo las lee enteras en cada turno—; el `tipo` va
     acotado por enum con lo que Odin manda en `operacionesCliente`, y los
     campos modificables salen de la misma lista blanca que aplica el cambio
     (`CAMPOS_EDITABLES` en Odin). Todas pegan a `/api/voice/operacion-cliente`.

   **Si Odin agrega un motor nuevo, el teléfono lo tiene sin tocar este repo.**
   No vuelvas a escribir a mano una tool de motor: eso es lo que tuvo por meses
   al asistente cerrando reparaciones por WhatsApp y no por llamada.

   **Y no reimplementes aquí ninguna regla de negocio**: qué se puede cambiar,
   en qué estado y de quién lo decide Odin en `operaciones-cliente.ts`, que es
   el mismo módulo que usa WhatsApp. Este repo solo declara la tool y repite el
   `texto` que devuelve la respuesta.

## Dos proveedores de telefonía: Twilio y Telnyx (nov-2026)

Twilio sigue siendo el de siempre y **no se tocó**: `/twiml`, `/ws`,
`/transferencia-estado`. Telnyx corre EN PARALELO para números comprados en
Telnyx (Odin guarda `config_voz.proveedor_numero = "telnyx"`). Usa su API
nativa (Call Control), no TeXML:

- `POST /telnyx/webhook` (`src/telnyx/webhook.ts`): todos los avisos de la Call
  Control Application. Firma ed25519 obligatoria (`TELNYX_PUBLIC_KEY`).
  `call.initiated` → pregunta a Odin `config-llamada?soloGate=1`; si el agente
  o la línea están apagados **rechaza sin contestar** (ocupado, sin costo, el
  equivalente del `<Reject/>` de Twilio). Si no, `answer` con audio μ-law
  bidireccional hacia `/ws-telnyx` y el contexto en `client_state`.
- `/ws-telnyx?ccid=…&t=…`: el token es un HMAC del call_control_id con
  `VOICE_SERVER_SECRET`. El mismo `PipelineLlamada` atiende, con
  `proveedor = "telnyx"`: cambian el formato de los frames, el `clear`, colgar
  (`hangup`), la despedida (`speak` con Polly.Mia y colgar en
  `call.speak.ended`) y la transferencia (`transfer` + `streaming_stop`).
- **Desvío / sucursal**: el `ForwardedFrom` de Twilio aquí es la cabecera SIP
  `Diversion` (`sip_headers` de `call.initiated`) → `numeroDeDiversion`.
- **Tramo humano**: la pierna de la transferencia lleva `client_state`
  `{k:"tr"}`; `call.answered`/`call.hangup` miden los segundos y se reporta a
  Odin con la misma `reportarTransferencia` que Twilio. Al terminar, se cuelga
  al cliente (como el `<Dial>` sin más verbos).
- Costo de telefonía: `costoTelefoniaTelnyxUsd` (US$0.0105/min local), viaja en
  el mismo `costoTwilioUsd` del cierre + `proveedorTelefonia`.
- Pruebas: `npm test` (`tests/telnyx.test.ts`).
- Env nuevas: `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`. Guía completa (portal,
  documentos, LADAs): `docs/GUIA-TELNYX-VOZ.md` en el repo de Odin.

## Dos motores de voz: OpenAI Realtime y el de Telnyx (nov-2026)

El **motor** es quien escucha, piensa y habla (`src/voz/motor.ts`, interfaz
`MotorVoz`). El `PipelineLlamada` no sabe cuál tiene: las herramientas las
ejecuta SIEMPRE `manejarFuncion`, así que agendar, cancelar, reagendar,
reservas, pedidos, cobros, motores, operaciones del cliente, ubicación,
escalar/transferir y colgar son **el mismo código** en los dos.

- **OpenAI Realtime** (`src/openai/realtime.ts`): voz a voz con gpt-realtime.
  Twilio siempre; Telnyx cuando la voz elegida es de OpenAI.
- **Telnyx** (`src/telnyx/relay.ts`, `MotorRelayTelnyx`): Conversation Relay.
  Telnyx transcribe (Deepgram **Flux multilenguaje** en español) y habla con sus
  voces (Ultra); por `/relay-telnyx` llega TEXTO y sale texto en fragmentos.
  Piensa **Claude** (`VOZ_RELAY_MODELO`, default `claude-haiku-5-5`: el de
  menor tiempo al primer texto; medido 350–650 ms con el prompt real).
- **Quién decide**: la voz. El webhook pregunta `config-llamada?soloGate=1`,
  que ahora devuelve `voz`; si es de Telnyx (`Telnyx.Ultra.…`, `esVozTelnyx`)
  contesta con `conversation_relay_config`, si no con el stream de siempre. Si
  Telnyx rechaza el relay, se contesta con OpenAI (la llamada no se pierde). Una
  voz de Telnyx en una línea de Twilio suena con Marin (`vozParaOpenAI`).
- **Respuesta anticipada**: Flux manda `eagerEndOfTurn` antes del texto final.
  Ahí ya se le pide la respuesta a Claude y se GUARDA; si el `prompt` final
  coincide (`mismoTurno`) se suelta de golpe, si llega `turnResumed` o dice otra
  cosa se tira. Las herramientas de una respuesta anticipada **no corren**
  hasta confirmarla (agendaría algo que el cliente no terminó de pedir).
- **Orden del historial**: el texto de un turno nuevo entra DESPUÉS de los
  `tool_result` del turno anterior (la API exige tool_result justo tras el
  tool_use). Por eso los turnos van en una cola (`cadena`) y una respuesta
  anticipada solo se compromete cuando la cola llegó a ella.
- **Diferencias que importan**: no hay tecleo ni room tone (no mandamos audio);
  la espera la cubre `fraseEspera` hablada. Colgar espera lo que le falta a la
  voz (`msHablaPendiente`); transferir espera 5 s (la frase se genera después
  del resultado) y luego `conversation_relay_stop`. Despedirse sin agente:
  cerrar el WS (termina el relay) y `speak` + colgar.
- **Prompt**: `bloquesSistema` lo parte en lo estable (caché entre llamadas) y
  el contexto + `REGLAS_TEXTO_A_VOZ` al FINAL (sin eso Haiku narraba sus
  deducciones: "hoy es lunes, así que mañana es…").
- **Costos**: IA = tokens de Claude (`costoClaudeUsd`); telefonía = Telnyx sin
  streaming + Relay $0.05/min + STT + voz Ultra por carácter (`costoRelayUsd`,
  conservador hasta ver una factura). Viajan en los campos de siempre, más
  `motorVoz`, `modeloIa` y `caracteresTts`.
- Env: `ANTHROPIC_API_KEY` (obligatoria para este motor), opcionales
  `VOZ_RELAY_MODELO`, `VOZ_RELAY_STT` (`deepgram/nova-3` = plan B),
  `VOZ_RELAY_EOT`, `VOZ_RELAY_EOT_TEMPRANO`, `VOZ_RELAY_PENSAR=1` (razonamiento
  oculto, ~+400 ms), `VOZ_RELAY_IDIOMA`.
- **Nunca una llamada muda** (17-nov-2026: las primeras llamadas con voz premium
  se quedaron en silencio porque Claude no podía pensar — llave faltante o
  inválida en el voice server — y la despedida por `speak` la cortaba Telnyx al
  desmontar el relay). Ahora: (1) `relayDisponible()` — sin `ANTHROPIC_API_KEY`, o
  10 min después de un error de llave/crédito (`marcarRelayCaido`), la línea
  contesta con el motor de OpenAI; (2) `atenderSinAgente` con relay se despide
  POR EL RELAY (misma voz) y luego cuelga; (3) `call.conversation_relay.ended` (el
  nombre real del evento; la doc dice `call.conversation.ended`) sin
  transferencia en curso → despedir y colgar.
- **Eco y voz baja** (17-nov-2026: el agente se oía a sí mismo —"Buenas noches,
  habla Sofía" regresó como "Ya, buenas noches. Habla Sophie"— y se contestaba;
  y a quien habla bajito no lo entendía). Dos capas:
  1. `limpiarAudio` (`suppression_start` de Telnyx) al iniciar cada llamada del
     relay: ai-coustics "voice focus" + `voice_gain` sobre la voz del CLIENTE,
     antes de transcribir. `intentosSupresion` arma planes B (sin config → otro
     motor) porque Telnyx valida el id de llamada antes que los parámetros y la
     combinación solo se confirma en vivo: busca en el log "Limpieza de voz
     encendida (…)". Env: `VOZ_SUPRESION` (motor, `0` apaga),
     `VOZ_SUPRESION_GANANCIA`, `VOZ_SUPRESION_INTENSIDAD`, `VOZ_SUPRESION_DIRECCION`.
  2. `pareceEco` en el motor: un texto que repite al agente EN ORDEN mientras
     habla (o ≤1.5 s después) se descarta. En la "cola" exige 3+ palabras, para
     no comerse "El martes" como respuesta a "¿martes o jueves?", y una palabra
     de respuesta ("sí", "no", "claro") que el agente no dijo lo descarta como
     eco siempre. Si el eco cortó al agente a media frase, termina la idea.
  El saludo va con `interruptible_greeting: "none"`.
- Pruebas: `tests/relay.test.ts` (con un Claude falso, sin red).

## Llamada de prueba (`POST /api/llamada-prueba`, solo Odin)

"Llamarme para probar" del panel: el agente le MARCA al dueño y corre la misma
llamada que con un cliente (misma config, herramientas, cobro y la conversación
entra a Odin; su número hace de "quien llama"). Telnyx: `POST /v2/calls` con el
relay o el stream embebidos; como al marcar no hay call_control_id, el token
firma número + destino con caducidad (`firmarSaliente`). Twilio: `calls.create`
con el mismo `<Stream>` (+ `prueba=1`). Tope de 5 min por llamada. Quién puede
recibirla y cuántas por hora lo decide Odin. Env: `TELNYX_VOZ_CONNECTION_ID`
(o Odin lo manda en el body).

## El prompt se paga en cada turno

La Realtime API vuelve a leer el prompt Y el esquema de las tools en cada
respuesta de la llamada. Por eso (nov-2026, tras las pruebas de Dentinova):

- **Servicios y citas van con IDs cortos** (`s1`, `c1`), no con UUID.
  `resolverServicioId` / `resolverCitaId` los traducen antes de pegarle a Odin;
  un UUID que llegue tal cual se respeta. Además de tokens, evitan el 404 de un
  UUID mal copiado.
- **Un solo horario** (`horarioCompacto`, de la tabla) y un **calendario** de
  14 días en el bloque del final (`calendarioVoz`): el modelo no calcula qué
  día cae el 12.
- **Nada dicho dos veces**: el precio va en el catálogo y no en la lista de
  agenda; el JSON de un marcador no va en el prompt si ya va en la tool.
- **Lo que varía por llamada va al final** (`=== CONTEXTO DE ESTA LLAMADA ===`)
  para que el prefijo se cachee. `tests/prompt-voz.test.ts` lo fija.

## Cuando OpenAI falla, nunca una línea muda

- Si OpenAI no conecta o se cae a media llamada (`atenderSinAgente`), el cliente
  oye un mensaje corto y se cuelga. Antes se quedaba en silencio hasta colgar.
- Si el error es falta de crédito (`insufficient_quota`), se avisa a Odin
  (`/api/voice/alerta-proveedor`) y Odin manda el correo al equipo. Aquí no hay
  SMTP: el freno de avisos vive en Odin.
- Una respuesta que no termina mientras el modelo arma una función suelta esa
  función (`funcionActual`); antes el agente quedaba mudo el resto de la llamada.

## Las dos reglas de los datos del cliente

Valen para las tres clases de tool y las aplica **Odin**, no este repo:

1. **Solo lo de quien está llamando.** El `telefonoCliente` que viaja en cada
   petición es el número desde el que entró la llamada (`callerNumber`), nunca
   algo que el modelo haya elegido en `args`. Del otro lado se compara por los
   ÚLTIMOS 10 DÍGITOS (`mismoTelefono`), porque el mismo número vive en la base
   como `52…`, `521…` y a veces nacional. Una referencia o un id **jamás**
   sustituyen al teléfono. Con número oculto no se consulta ni se mueve nada.
2. **Solo lo que ese negocio tiene encendido.** `config-llamada` manda
   únicamente las operaciones de sus motores activos y los datos del dueño de
   las operaciones activas — lo apagado no viaja, ni como tool ni como tokens
   de prompt. Aun así, cada endpoint vuelve a resolver los motores **leyendo la
   base al momento de la llamada**: la config que trae el voice server es una
   optimización, no la autorización.
4. La configuración de cada negocio (catálogo, horarios, habilidades activas,
   métodos de pago, etc.) la entrega Odin en caliente por HTTP
   (`config.odinAppUrl` + `/api/voice/...`), no vive en este repo.

## Importante: módulos legacy sin usar

`src/claude/responder.ts` (Anthropic SDK) y `src/deepgram/stt.ts` /
`src/deepgram/tts.ts` son de una **arquitectura anterior** (STT/LLM/TTS en
pasos separados). Ya **no están importados desde `src/index.ts`** ni desde el
pipeline activo — la llamada completa hoy la resuelve `gpt-realtime` de
OpenAI directo. No asumas que tocar/arreglar algo ahí afecta llamadas reales;
confirma primero si el archivo está importado en la cadena activa
(`index.ts` → `pipeline/llamada.ts` → `openai/realtime.ts`).

## Estructura

```
src/
├── index.ts              # servidor Express + WebSocket, rutas y warmup de Odin
├── twilio/twiml.ts        # TwiML de entrada (Connect/Stream) y fallback
├── openai/realtime.ts     # cliente de la Realtime API (gpt-realtime), tools, audio pcmu
├── pipeline/llamada.ts    # orquestador de la llamada: prompt, tools, llamadas a Odin
├── api/
│   ├── configurar.ts      # config en memoria por negocioId (legacy/fallback)
│   ├── registro-voz.ts    # registro en memoria: voz elegida por número de Twilio
│   └── preview-voz.ts     # preview de voz para el panel (llamado desde el navegador)
├── claude/responder.ts    # LEGACY — no usado en el pipeline activo
├── deepgram/{stt,tts}.ts  # LEGACY — no usado en el pipeline activo
└── utils/{audio,config}.ts
```

## Variables de entorno

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
`DEEPGRAM_API_KEY` (legacy), `ANTHROPIC_API_KEY` (legacy), `OPENAI_API_KEY`
(activo — Realtime API), `ODIN_APP_URL`, `VOICE_SERVER_SECRET` (secreto
compartido con Odin, ver `AGENTS.md` de Odin), `PORT`, `VOICE_SERVER_URL`.

## Deploy

No es un proyecto Vercel: corre en **Docker** sobre un VPS con **Dokploy /
Traefik** (`docker-compose.yml`), expuesto en `voice-odin.duckdns.org` con
TLS de Let's Encrypt. `npm run build` compila con `tsc` a `dist/`, `npm start`
corre `dist/index.js`.

## Comandos

```bash
npm run dev      # tsx watch — desarrollo local
npm run build    # compila TypeScript a dist/
npm start        # corre el build (producción, dentro del contenedor)
```
