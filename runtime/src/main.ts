/** Entry point: loads config, wires the runtime, connects to the shim. */
import { SocketEngine } from "./engine";
import { loadConfig } from "./config";
import { Runtime } from "./runtime";
import { log } from "./util";

const socketPath = process.env.VERGE_SOCKET ?? "verge.sock";

const config = await loadConfig();
const engine = new SocketEngine(socketPath);
const runtime = new Runtime(engine, config);

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection:", reason);
});

await runtime.start();
