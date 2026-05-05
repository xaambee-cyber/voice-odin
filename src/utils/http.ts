// HTTP keep-alive global. Sin esto, cada fetch a Odin abre una conexión TLS
// nueva (~400ms de handshake medido). Con keep-alive, las conexiones se
// reutilizan entre llamadas → la segunda y siguientes function calls bajan
// de ~700ms a ~200ms.
//
// IMPORTANTE: undici v7 requiere Node 22+. Estamos en Node 20, así que el
// package.json fija undici@^6. Si por alguna razón el módulo falla al
// cargar, atrapamos el error y seguimos sin keep-alive — preferible a que
// el servidor crashee y Twilio reciba 404s.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Agent, setGlobalDispatcher } = require("undici");
  const agent = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connections: 10,
    pipelining: 0,
  });
  setGlobalDispatcher(agent);
  console.log("[HTTP] Keep-alive habilitado (undici Agent global)");
} catch (err: any) {
  console.warn("[HTTP] No se pudo habilitar keep-alive:", err?.message || err);
  console.warn("[HTTP] El servidor sigue funcionando sin keep-alive (latencia ligeramente mayor)");
}
