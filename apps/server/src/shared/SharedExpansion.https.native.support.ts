// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in transport acceptance owns disposable certificates and bounded loopback proxies.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import { bounded } from "../provider/meerkat/MeerkatWorkflow.server.native.support.ts";

const certificateKinds = ["trusted", "untrusted", "wrong-host"] as const;
type CertificateKind = (typeof certificateKinds)[number];
type CleanupObservation = { stage: string; status: "fulfilled" | "rejected"; error?: string };
const failureText = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const cleanupText = (observations: readonly CleanupObservation[]) =>
  observations.map((entry) => `${entry.stage}: ${entry.error ?? entry.status}`).join("; ");

/** TLS termination only. HTTP, WebSocket authentication, RPC and grants belong to the real server. */
async function tlsProxy(directory: string, kind: CertificateKind, upstreamPort: number) {
  const sockets = new Set<NodeNet.Socket>();
  const protocols = new Set<string>();
  let tcpConnections = 0;
  let secureConnections = 0;
  let upstreamConnections = 0;
  let handshakeErrors = 0;
  let upstreamErrors = 0;
  let receivedBytes = 0;
  let sentBytes = 0;
  let closing = false;
  const server = NodeTls.createServer(
    {
      key: await NodeFSP.readFile(NodePath.join(directory, `${kind}.key`)),
      cert: await NodeFSP.readFile(NodePath.join(directory, `${kind}.pem`)),
      minVersion: "TLSv1.2",
      handshakeTimeout: 10_000,
    },
    (client) => {
      if (closing) {
        client.destroy();
        return;
      }
      secureConnections++;
      protocols.add(client.getProtocol() ?? "unknown");
      const upstream = NodeNet.connect({ host: "127.0.0.1", port: upstreamPort });
      sockets.add(client);
      sockets.add(upstream);
      // The proxy does not inspect, retain or log headers, credentials or message bodies.
      client.on("data", (chunk: Buffer) => (receivedBytes += chunk.byteLength));
      upstream.on("data", (chunk: Buffer) => (sentBytes += chunk.byteLength));
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.once("connect", () => {
        upstreamConnections++;
      });
      upstream.once("error", () => {
        upstreamErrors++;
        client.destroy();
      });
      client.on("error", () => upstream.destroy());
      for (const socket of [client, upstream]) {
        socket.setTimeout(120_000, () => socket.destroy());
        socket.once("close", () => {
          sockets.delete(socket);
          (socket === client ? upstream : client).destroy();
        });
      }
    },
  );
  server.maxConnections = 128;
  server.on("connection", (socket) => {
    tcpConnections++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  server.on("tlsClientError", () => handshakeErrors++);
  const close = async () => {
    closing = true;
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
          ? reject(error)
          : resolve(),
      ),
    );
    for (const socket of sockets) socket.destroy();
    await bounded(closed, "disposable TLS proxy close", 5_000);
  };
  let port: number;
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          if (closing) {
            // A late listen callback after the startup deadline cannot orphan a listener.
            server.close(() => undefined);
            reject(new Error("Disposable TLS proxy startup was canceled"));
          } else resolve();
        });
      }),
      "disposable TLS proxy startup",
      10_000,
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No disposable TLS proxy port");
    port = address.port;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `TLS proxy startup failed: ${failureText(error)}; cleanup failed: ${failureText(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
  return {
    origin: `https://127.0.0.1:${port}`,
    observe: () => ({
      tcpConnections,
      secureConnections,
      upstreamConnections,
      handshakeErrors,
      upstreamErrors,
      receivedBytes,
      sentBytes,
      protocols: [...protocols].sort(),
    }),
    close,
  };
}

/** Trust is scoped to personal server children via NODE_EXTRA_CA_CERTS at process startup. */
export async function prepareSharedTlsFixture(directory: string, upstreamPort: number) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const proxies = new Map<CertificateKind, Awaited<ReturnType<typeof tlsProxy>>>();
  let cleanupObservations: CleanupObservation[] = [];
  const openssl = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile(
        "/usr/bin/openssl",
        args,
        {
          cwd: directory,
          env: { PATH: "/usr/bin:/bin", HOME: directory, LANG: "C" },
          timeout: 15_000,
          maxBuffer: 65_536,
        },
        (error) =>
          error ? reject(new Error("Disposable TLS certificate generation failed")) : resolve(),
      );
    });
  const cleanKeys = async () => {
    const entries = (await NodeFSP.readdir(directory)).filter((name) => !name.endsWith(".pem"));
    const removed = await Promise.allSettled(
      entries.map((name) => NodeFSP.rm(NodePath.join(directory, name), { force: true })),
    );
    const failed = removed.flatMap((entry, index) =>
      entry.status === "rejected" ? [{ name: entries[index]!, error: entry.reason }] : [],
    );
    if (failed.length > 0)
      throw new AggregateError(
        failed.map((entry) => entry.error),
        `Could not remove generated TLS files: ${failed.map((entry) => entry.name).join(", ")}`,
      );
  };
  const cleanup = async () => {
    const entries = [...proxies.entries()];
    const results = await Promise.allSettled(entries.map(([, proxy]) => proxy.close()));
    const [keys] = await Promise.allSettled([cleanKeys()]);
    cleanupObservations = [...results, keys!].map((result, index) => ({
      stage: index < entries.length ? `proxy:${entries[index]![0]}` : "private-key-removal",
      status: result.status,
      ...(result.status === "rejected" ? { error: failureText(result.reason) } : {}),
    }));
    return cleanupObservations;
  };
  try {
    await NodeFSP.writeFile(
      NodePath.join(directory, "ca.cnf"),
      "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=MeerkaT3 disposable acceptance CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
      { mode: 0o600 },
    );
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-config",
      "ca.cnf",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    ]);
    for (const kind of certificateKinds) {
      const san = kind === "wrong-host" ? "DNS:wrong-host.example.invalid" : "IP:127.0.0.1";
      await NodeFSP.writeFile(
        NodePath.join(directory, `${kind}.cnf`),
        `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=MeerkaT3 disposable ${kind} endpoint\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,
        { mode: 0o600 },
      );
      if (kind === "untrusted") {
        await openssl([
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-sha256",
          "-days",
          "1",
          "-config",
          `${kind}.cnf`,
          "-extensions",
          "server",
          "-keyout",
          `${kind}.key`,
          "-out",
          `${kind}.pem`,
        ]);
      } else {
        await openssl([
          "req",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-sha256",
          "-config",
          `${kind}.cnf`,
          "-keyout",
          `${kind}.key`,
          "-out",
          `${kind}.csr`,
        ]);
        await openssl([
          "x509",
          "-req",
          "-in",
          `${kind}.csr`,
          "-CA",
          "ca.pem",
          "-CAkey",
          "ca.key",
          "-set_serial",
          kind === "trusted" ? "1" : "2",
          "-sha256",
          "-days",
          "1",
          "-extfile",
          `${kind}.cnf`,
          "-extensions",
          "server",
          "-out",
          `${kind}.pem`,
        ]);
      }
      await NodeFSP.chmod(NodePath.join(directory, `${kind}.key`), 0o600);
      proxies.set(kind, await tlsProxy(directory, kind, upstreamPort));
    }
    await NodeFSP.chmod(NodePath.join(directory, "ca.key"), 0o600);
    const caPath = NodePath.join(directory, "ca.pem");
    const ca = new NodeCrypto.X509Certificate(await NodeFSP.readFile(caPath));
    return {
      caPath,
      trustedOrigin: proxies.get("trusted")!.origin,
      untrustedOrigin: proxies.get("untrusted")!.origin,
      wrongHostOrigin: proxies.get("wrong-host")!.origin,
      cleanupObservation: () => cleanupObservations,
      observe: () => ({
        transport: "https-wss",
        trust: "disposable CA in personal server NODE_EXTRA_CA_CERTS",
        caSha256: ca.fingerprint256,
        hostname: "127.0.0.1",
        trusted: proxies.get("trusted")!.observe(),
        untrusted: proxies.get("untrusted")!.observe(),
        wrongHost: proxies.get("wrong-host")!.observe(),
      }),
      async close() {
        const observations = await cleanup();
        if (observations.some((entry) => entry.status === "rejected"))
          throw new Error(`Disposable TLS cleanup failed: ${cleanupText(observations)}`);
      },
    };
  } catch (error) {
    const observations = await cleanup();
    if (observations.some((entry) => entry.status === "rejected"))
      throw new Error(
        `Disposable TLS setup failed: ${failureText(error)}; cleanup: ${cleanupText(observations)}`,
        { cause: error },
      );
    throw error;
  }
}
