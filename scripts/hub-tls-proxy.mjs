// Minimal TLS terminator in front of the plain-ws hub. A real Jibo's jibo-jetstream-service
// hardcodes wss:// (https://) for the hub and its override only sets host/port, never the scheme —
// so it connects wss://<hub_hostname>:<hub_port> while @phoenix/gateway serves plain ws. This proxy
// accepts the robot's TLS on TLS_PORT, terminates it, and pipes the decrypted byte stream to the
// plain hub on HUB_PORT (WebSocket upgrade flows through transparently — it's just TCP after the
// handshake). Point the robot's Jetstream override hub_port at TLS_PORT.
//
//   env: TLS_PORT (default 9443) · HUB_PORT (default 9000) · TLS_CERT · TLS_KEY
import { createServer } from 'node:tls';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';

const TLS_PORT = Number(process.env.TLS_PORT || 9443);
const HUB_PORT = Number(process.env.HUB_PORT || 9000);
const opts = {
  key: readFileSync(process.env.TLS_KEY || '/tmp/hub-key.pem'),
  cert: readFileSync(process.env.TLS_CERT || '/tmp/hub-cert.pem'),
};

const server = createServer(opts, (client) => {
  const upstream = connect(HUB_PORT, '127.0.0.1');
  const bail = (who) => (e) => { console.log(`${who} error: ${e.message}`); client.destroy(); upstream.destroy(); };
  client.on('error', bail('client'));
  upstream.on('error', bail('upstream'));
  client.pipe(upstream);
  upstream.pipe(client);
});
// Surface handshake/cert rejections (e.g. the robot pinning/validating our self-signed cert).
server.on('tlsClientError', (e, sock) => console.log(`tlsClientError from ${sock.remoteAddress}: ${e.message}`));
server.listen(TLS_PORT, () => console.log(`hub TLS proxy listening :${TLS_PORT} -> 127.0.0.1:${HUB_PORT}`));
