import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ALLOWED = new Set(["unassigned", "high", "medium", "low"]);

export function createDiscrepancyPriorityStore(manifestPath) {
  const dir = path.join(path.dirname(path.resolve(manifestPath)), ".contextcake");
  const file = path.join(dir, "discrepancy-priorities.json");

  async function list() {
    try {
      const value = JSON.parse(await fsp.readFile(file, "utf8"));
      if (value?.version !== 1 || !value.priorities || Array.isArray(value.priorities)) throw new Error("unsupported document");
      return Object.fromEntries(Object.entries(value.priorities).filter(([, priority]) => ALLOWED.has(priority)));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error(`Discrepancy priorities are unreadable: ${error.message}`);
    }
  }

  async function set(id, priority) {
    if (typeof id !== "string" || !id || !ALLOWED.has(priority)) throw new Error("Invalid discrepancy priority");
    const priorities = await list();
    if (priority === "unassigned") delete priorities[id]; else priorities[id] = priority;
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify({ version: 1, priorities }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temp, file);
    return priority;
  }
  return { file, list, set };
}
