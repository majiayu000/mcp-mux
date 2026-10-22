// Per-account credential storage: macOS Keychain (via the `security` CLI) or an AES-256-GCM encrypted file.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { StoreConfig } from "./config.ts";

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SERVICE = "mcp-mux";
const NOT_FOUND = 44; // `security` exit code for errSecItemNotFound

export class KeychainStore implements SecretStore {
  constructor(private keychain?: string) {}

  private async run(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
    const p = Bun.spawn(["security", ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (stdin !== undefined) {
      p.stdin!.write(stdin);
      p.stdin!.end();
    }
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  }

  async get(key: string) {
    const r = await this.run(["find-generic-password", "-s", SERVICE, "-a", key, "-w", ...(this.keychain ? [this.keychain] : [])]);
    if (r.code === NOT_FOUND) return undefined;
    if (r.code !== 0) throw new Error(`keychain read failed for ${key}: ${r.err.trim()}`);
    return Buffer.from(r.out.trim(), "base64").toString("utf8");
  }

  async set(key: string, value: string) {
    // `security -i` reads the command from stdin, so the secret never shows up in the process list.
    const kc = this.keychain ? ` "${this.keychain.replace(/"/g, '\\"')}"` : "";
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const r = await this.run(["-i"], `add-generic-password -U -s ${SERVICE} -a ${key} -w ${b64}${kc}\n`);
    if (r.code !== 0 || r.err.trim()) throw new Error(`keychain write failed for ${key}: ${r.err.trim()}`);
  }

  async delete(key: string) {
    const r = await this.run(["delete-generic-password", "-s", SERVICE, "-a", key, ...(this.keychain ? [this.keychain] : [])]);
    if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`keychain delete failed for ${key}: ${r.err.trim()}`);
  }
}

type Sealed = { iv: string; tag: string; data: string };

export class EncryptedFileStore implements SecretStore {
  private key: Buffer;
  private queue: Promise<void> = Promise.resolve();

  constructor(private path: string, keyB64: string | undefined) {
    if (!keyB64) throw new Error("file store needs MCP_MUX_STORE_KEY (base64 of 32 random bytes, e.g. `openssl rand -base64 32`)");
    this.key = Buffer.from(keyB64, "base64");
    if (this.key.length !== 32) throw new Error("MCP_MUX_STORE_KEY must decode to exactly 32 bytes");
  }

  private async read(): Promise<Record<string, Sealed>> {
    const f = Bun.file(this.path);
    return (await f.exists()) ? f.json() : {};
  }

  private async write(all: Record<string, Sealed>) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await Bun.write(tmp, JSON.stringify(all, null, 2));
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  async get(key: string) {
    const s = (await this.read())[key];
    if (!s) return undefined;
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(s.iv, "base64"));
    d.setAAD(Buffer.from(key)); // binds the ciphertext to its key, so entries cannot be swapped between accounts
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    try {
      return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
    } catch {
      throw new Error(`cannot decrypt stored credentials for ${key}: wrong MCP_MUX_STORE_KEY or tampered file ${this.path}`);
    }
  }

  // Accounts share one file, so read-modify-write runs one at a time within this process.
  private update(change: (all: Record<string, Sealed>) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const all = await this.read();
      change(all);
      await this.write(all);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  set(key: string, value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(key));
    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
    const sealed = { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
    return this.update((all) => {
      all[key] = sealed;
    });
  }

  delete(key: string) {
    return this.update((all) => {
      delete all[key];
    });
  }
}

export function openStore(cfg: StoreConfig | undefined, env: Record<string, string | undefined> = process.env): SecretStore {
  const type = cfg?.type ?? (process.platform === "darwin" ? "keychain" : "file");
  if (type === "keychain") return new KeychainStore(cfg?.type === "keychain" ? cfg.keychain : undefined);
  const path = (cfg?.type === "file" && cfg.path) || join(homedir(), ".config", "mcp-mux", "credentials.json");
  return new EncryptedFileStore(path, env.MCP_MUX_STORE_KEY);
}
