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

   - **Fijas**, escritas en este repo: `agendar_cita`, `cancelar_cita`,
     `reagendar_cita`, `solicitar_reserva`, `crear_pedido`, `escalar_humano`,
     `registrar_pregunta`, `colgar_llamada`, `enviar_ubicacion`. Cada una tiene
     su `case` en `manejarFuncion` y su endpoint propio en Odin.
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
