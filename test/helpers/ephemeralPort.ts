import net from "node:net";

/** Binds to port 0, returns the assigned port, then releases it (for CLI --port probes). */
export function reserveFreeTcpPort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        probe.close(() => reject(new Error("Failed to reserve ephemeral port")));
        return;
      }
      const port = addr.port;
      probe.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}
