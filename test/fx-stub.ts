import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A local stand-in for the FX provider so no e2e suite touches the network.
 * `url` carries the provider path, `hits` counts requests, and `close` tears
 * the server down together with every connection still open on it, so a hung
 * request can never keep the Jest process alive.
 */
export interface FxStub {
  readonly url: string;
  hits(): number;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function start(handler: Handler): Promise<FxStub> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v6/latest/USD`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // close() alone waits for open connections; a black hole never ends its own.
        server.closeAllConnections();
      }),
  };
}

/** A provider that answers every request with `body` as JSON. */
export function startFxProvider(body: string): Promise<FxStub> {
  return start((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
}

/**
 * A provider that accepts the connection and never answers: what a hung
 * upstream looks like to the client. Only the client's timeout ends the
 * exchange, so the time to a response measures that timeout and nothing else.
 */
export function startBlackHole(): Promise<FxStub> {
  return start(() => undefined);
}
