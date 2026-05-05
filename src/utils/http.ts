import { Agent, setGlobalDispatcher } from "undici";

// HTTP keep-alive global. Sin esto, cada fetch a Odin abre una conexión TLS
// nueva (~400ms de handshake medido). Con keep-alive, las conexiones se
// reutilizan entre llamadas → la segunda y siguientes function calls bajan
// de ~700ms a ~200ms.
//
// connections: 10  → pool máximo de 10 conexiones simultáneas
// keepAliveTimeout → tiempo que la conexión se mantiene abierta inactiva
// pipelining: 0    → desactivado (HTTP/1.1 pipelining causa bugs raros)
const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 10,
  pipelining: 0,
});

setGlobalDispatcher(agent);

console.log("[HTTP] Keep-alive habilitado (undici Agent global)");
