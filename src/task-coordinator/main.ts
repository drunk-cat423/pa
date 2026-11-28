import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { privateDirectory, startCoordinator } from "./service.js";
import { TaskDeliveryStore } from "./delivery-store.js";
import { TaskCoordinatorStore } from "./store.js";

function readToken(path: string): string {
  if (!isAbsolute(path) || !lstatSync(path).isFile()) throw new Error("invalid_credential");
  const file = openSync(path, "r");
  try {
    const entry = fstatSync(file);
    const uid = process.getuid?.();
    if (!entry.isFile() || entry.size > 258 ||
        (uid !== undefined && (entry.uid !== uid || (entry.mode & 0o077) !== 0))) {
      throw new Error("invalid_credential");
    }
    const bytes = Buffer.alloc(259);
    const length = readSync(file, bytes, 0, bytes.length, null);
    if (length !== entry.size) throw new Error("invalid_credential");
    return bytes.subarray(0, length).toString("utf8").replace(/\r?\n$/, "");
  } finally {
    closeSync(file);
  }
}

async function run(): Promise<void> {
  const [runtimeDirectory, socketPath, owner, credentialFile, ...extra] = process.argv.slice(2);
  if (!runtimeDirectory || !socketPath || !owner || !credentialFile || extra.length !== 0) {
    process.stderr.write("Usage: node dist/task-coordinator/main.js <runtimeDirectory> <socketPath> <owner> <credentialFile>\n");
    process.exitCode = 1;
    return;
  }
  if (!privateDirectory(runtimeDirectory)) throw new Error("invalid_runtime_directory");
  let token: string;
  try {
    token = readToken(credentialFile);
  } catch {
    throw new Error("invalid_credential");
  }

  const database = join(runtimeDirectory, "task-coordinator.sqlite");
  const entry = lstatSync(database, { throwIfNoEntry: false });
  if (entry && !entry.isFile()) throw new Error("invalid_runtime_directory");
  if (process.platform !== "win32") process.umask(0o077);
  const store = new TaskCoordinatorStore(database);
  let deliveryStore: TaskDeliveryStore | undefined;
  let service: Awaited<ReturnType<typeof startCoordinator>>;
  try {
    deliveryStore = new TaskDeliveryStore(database);
    service = await startCoordinator({ socketPath, owner, token, store, deliveryStore });
  } catch (error) {
    try { deliveryStore?.close(); }
    finally { store.close(); }
    throw error;
  }

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    void service.close().finally(() => {
      try { deliveryStore?.close(); }
      finally { store.close(); }
    }).catch(() => {
      process.stderr.write("Task coordinator could not close.\n");
      process.exitCode = 1;
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdout.write("Task coordinator is ready.\n");
}

void run().catch((error: unknown) => {
  const messages = new Map([
    ["invalid_credential", "Invalid PA credential or owner."],
    ["invalid_runtime_directory", "An existing private coordinator runtime directory is required."],
    ["invalid_endpoint", "Invalid local coordinator endpoint."],
    ["endpoint_in_use", "The local coordinator endpoint already exists."],
    ["endpoint_unavailable", "The local coordinator endpoint is unavailable."],
  ]);
  const message = error instanceof Error ? messages.get(error.message) : undefined;
  process.stderr.write((message ?? "Task coordinator could not start.") + "\n");
  process.exitCode = 1;
});
