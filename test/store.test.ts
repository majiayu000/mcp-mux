import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { EncryptedFileStore, KeychainStore } from "../src/store.ts";
import { tmp } from "./helpers.ts";

const key = () => randomBytes(32).toString("base64");

describe("EncryptedFileStore", () => {
  test("round-trips per key, encrypts at rest, 0600", async () => {
    const path = join(await tmp("store"), "creds.json");
    const k = key();
    const s = new EncryptedFileStore(path, k);
    await s.set("mail/work", '{"tokens":{"access_token":"secret-work"}}');
    await s.set("mail/home", '{"tokens":{"access_token":"secret-home"}}');
    expect(await s.get("mail/work")).toContain("secret-work");
    expect(await new EncryptedFileStore(path, k).get("mail/home")).toContain("secret-home");
    expect(await Bun.file(path).text()).not.toContain("secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await s.delete("mail/work");
    expect(await s.get("mail/work")).toBeUndefined();
    expect(await s.get("mail/home")).toContain("secret-home");
  });

  test("wrong key or swapped entries fail loudly", async () => {
    const path = join(await tmp("store"), "creds.json");
    const s = new EncryptedFileStore(path, key());
    await s.set("mail/work", "w");
    await s.set("mail/home", "h");
    await expect(new EncryptedFileStore(path, key()).get("mail/work")).rejects.toThrow("cannot decrypt");
    const all = await Bun.file(path).json();
    await Bun.write(path, JSON.stringify({ ...all, "mail/home": all["mail/work"] }));
    await expect(s.get("mail/home")).rejects.toThrow("cannot decrypt");
  });

  test("requires a 32-byte key", () => {
    expect(() => new EncryptedFileStore("/x", undefined)).toThrow("MCP_MUX_STORE_KEY");
    expect(() => new EncryptedFileStore("/x", "c2hvcnQ=")).toThrow("32 bytes");
  });
});

describe.if(process.platform === "darwin")("KeychainStore (temporary keychain)", () => {
  test("round-trips and deletes without touching the login keychain", async () => {
    const kc = join(await tmp("kc"), "test.keychain-db");
    for (const args of [["create-keychain", "-p", "pw", kc], ["unlock-keychain", "-p", "pw", kc]]) {
      expect(Bun.spawnSync(["security", ...args]).exitCode).toBe(0);
    }
    try {
      const s = new KeychainStore(kc);
      expect(await s.get("mail/work")).toBeUndefined();
      const value = JSON.stringify({ tokens: { access_token: "a b \"quoted\" ✓" } });
      await s.set("mail/work", value);
      await s.set("mail/work", value); // update in place
      expect(await s.get("mail/work")).toBe(value);
      await s.delete("mail/work");
      expect(await s.get("mail/work")).toBeUndefined();
    } finally {
      Bun.spawnSync(["security", "delete-keychain", kc]);
    }
  });
});
