import { createGameServer } from './server.js';

const port = Number(process.env.PORT ?? 8080);
createGameServer(port).then((srv) => {
  console.log(`mk-ultra server listening on :${srv.port}`);
});
