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
   define las **tools** que el modelo puede invocar (`agendar_cita`,
   `cancelar_cita`, `reagendar_cita`, `solicitar_reserva`, `crear_pedido`,
   `escalar_humano`, `registrar_pregunta`, `colgar_llamada`,
   `enviar_ubicacion`) y las ejecuta llamando de vuelta a **Odin** (la app
   Next.js) por HTTP con el secreto compartido `VOICE_SERVER_SECRET`.
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
