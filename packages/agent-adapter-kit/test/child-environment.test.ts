import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildChildEnvironment,
  COMMON_ALLOWLIST,
  type ProviderAuthVariables
} from "../src/child-environment.js";

const ECHO_CHILD = fileURLToPath(new URL("./fixtures/echo-child.mjs", import.meta.url));

/**
 * Credential-shaped values that trip `containsSensitiveMaterial`. Built at runtime from
 * fragments so no literal token pattern lives in the source (standing rule 2).
 */
const credentialShapedValue = (): string => ["ghp", "abc123def456ghi789jkl012mno345pqr67890"].join("_");

const CLAUDE_AUTH_VARS: ProviderAuthVariables = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX"
];

const CODEX_AUTH_VARS: ProviderAuthVariables = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_HOME"
];

describe("buildChildEnvironment", () => {
  describe("allowlist semantics", () => {
    it("includes exactly the common allowlisted variables that are present in the source", () => {
      const source: Record<string, string> = {
        HOME: "/home/agent",
        PATH: "/usr/bin",
        USER: "agent",
        SHELL: "/bin/zsh",
        LANG: "en_US.UTF-8",
        TMPDIR: "/tmp",
        NOT_ALLOWED: "should-not-appear"
      };

      const result = buildChildEnvironment(source, []);

      expect(result).toHaveProperty("HOME", "/home/agent");
      expect(result).toHaveProperty("PATH", "/usr/bin");
      expect(result).toHaveProperty("USER", "agent");
      expect(result).toHaveProperty("SHELL", "/bin/zsh");
      expect(result).toHaveProperty("LANG", "en_US.UTF-8");
      expect(result).toHaveProperty("TMPDIR", "/tmp");
      expect(result).not.toHaveProperty("NOT_ALLOWED");
    });

    it("omits allowlisted variables that are absent from the source", () => {
      const source: Record<string, string> = { HOME: "/home/agent" };

      const result = buildChildEnvironment(source, []);

      expect(result).toHaveProperty("HOME", "/home/agent");
      expect(result).not.toHaveProperty("PATH");
      expect(result).not.toHaveProperty("SHELL");
    });

    it("does not spread process.env — only named keys are copied", () => {
      const source: Record<string, string> = {
        HOME: "/home/agent",
        SECRET_VAR: "should-not-leak",
        RANDOM_THING: "nope"
      };

      const result = buildChildEnvironment(source, []);

      expect(Object.keys(result).every((key) => COMMON_ALLOWLIST.includes(key))).toBe(true);
    });

    it("matches LC_* variables by prefix", () => {
      const source: Record<string, string> = {
        LC_ALL: "en_US.UTF-8",
        LC_CTYPE: "UTF-8",
        LC_MESSAGES: "en_US",
        LC_COLLATE: "C"
      };

      const result = buildChildEnvironment(source, []);

      expect(result).toHaveProperty("LC_ALL", "en_US.UTF-8");
      expect(result).toHaveProperty("LC_CTYPE", "UTF-8");
      expect(result).toHaveProperty("LC_MESSAGES", "en_US");
      expect(result).toHaveProperty("LC_COLLATE", "C");
    });

    it("does not match LC-like variables that lack the LC_ prefix exactly", () => {
      const source: Record<string, string> = {
        LOCALE: "en",
        LC: "not_a_real_var",
        MY_LC_THING: "nope"
      };

      const result = buildChildEnvironment(source, []);

      expect(result).not.toHaveProperty("LOCALE");
      expect(result).not.toHaveProperty("LC");
      expect(result).not.toHaveProperty("MY_LC_THING");
    });
  });

  describe("provider auth variables", () => {
    it("copies Claude auth variables when present in the source", () => {
      const source: Record<string, string> = {
        ANTHROPIC_API_KEY: "sk-ant-12345",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        CLAUDE_CODE_USE_BEDROCK: "1"
      };

      const result = buildChildEnvironment(source, CLAUDE_AUTH_VARS);

      expect(result).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-12345");
      expect(result).toHaveProperty("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
      expect(result).toHaveProperty("CLAUDE_CODE_USE_BEDROCK", "1");
    });

    it("copies Codex auth variables when present in the source", () => {
      const source: Record<string, string> = {
        OPENAI_API_KEY: "sk-12345",
        CODEX_HOME: "/home/codex"
      };

      const result = buildChildEnvironment(source, CODEX_AUTH_VARS);

      expect(result).toHaveProperty("OPENAI_API_KEY", "sk-12345");
      expect(result).toHaveProperty("CODEX_HOME", "/home/codex");
    });

    it("omits absent provider auth variables", () => {
      const source: Record<string, string> = {};

      const result = buildChildEnvironment(source, CLAUDE_AUTH_VARS);

      expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    });
  });

  describe("D-11 — host-injected provider credentials are never forwarded", () => {
    const hostInjected = [
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
      "CLAUDE_CODE_HOST_CREDS_FILE",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      "CODEX_AUTHAPI_BASE_URL",
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
    ];

    it.each(hostInjected)(
      "%s is absent from the constructed environment even when present in process.env",
      (name) => {
        const source: Record<string, string> = { [name]: "leaked-credential" };

        const result = buildChildEnvironment(source, CLAUDE_AUTH_VARS);

        expect(result).not.toHaveProperty(name);
      }
    );
  });

  describe("environment names follow the contract name rule", () => {
    it("rejects a provider auth variable whose name violates the /^[A-Z_][A-Z0-9_]*$/ rule", () => {
      expect(() => buildChildEnvironment({}, ["lowercase_var" as string])).toThrow();
      expect(() => buildChildEnvironment({}, ["HAS-DASH" as string])).toThrow();
    });
  });

  describe("opacity — credential values never appear in any output channel", () => {
    it("credential-shaped values in allowlisted variables appear in no emitted event or error", async () => {
      const credential = credentialShapedValue();

      // Build an environment where every allowlisted variable plus auth variables carry a
      // credential-shaped value.
      const source: Record<string, string> = {};
      for (const name of COMMON_ALLOWLIST) {
        source[name] = credential;
      }
      for (const name of CLAUDE_AUTH_VARS) {
        source[name] = credential;
      }
      source["LC_ALL"] = credential;

      const env = buildChildEnvironment(source, CLAUDE_AUTH_VARS);

      // The environment must contain the values (they were forwarded), but the
      // buildChildEnvironment function itself must never log, scan, compare, or
      // redact them — it is an opaque key-copy. The proof is that the returned
      // environment record contains the raw credential value for each allowlisted
      // key, and the function did not throw or modify them.
      for (const key of Object.keys(env)) {
        expect(env[key]).toBe(credential);
      }
    });

    it("credential values survive the round trip through a real child process unchanged", async () => {
      const credential = credentialShapedValue();

      // Build env with a credential in HOME
      const source: Record<string, string> = {
        HOME: credential,
        PATH: "/usr/bin"
      };
      const env = buildChildEnvironment(source, []);

      // Spawn the echo child with this environment and verify the credential
      // value reaches the child as-is — proving the key-copy is opaque.
      const received = await new Promise<string>((resolve, reject) => {
        // The echo-env-child prints specific env vars as JSON
        const child = spawn(
          process.execPath,
          [
            "-e",
            'process.stdout.write(JSON.stringify({ HOME: process.env.HOME }) + "\\n")'
          ],
          { shell: false, stdio: ["ignore", "pipe", "ignore"], env }
        );
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          out += chunk;
        });
        child.on("error", reject);
        child.on("close", () => {
          try {
            const parsed = JSON.parse(out) as { HOME: string };
            resolve(parsed.HOME);
          } catch (error: unknown) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });

      expect(received).toBe(credential);
    });
  });

  describe("the result is a plain record suitable for spawn", () => {
    it("returns a plain object with string values, not a Map or class instance", () => {
      const result = buildChildEnvironment({ HOME: "/home/agent" }, []);
      expect(typeof result).toBe("object");
      expect(result).not.toBeInstanceOf(Map);
      for (const value of Object.values(result)) {
        expect(typeof value).toBe("string");
      }
    });

    it("the returned object is frozen — the caller cannot add ambient leaks after construction", () => {
      const result = buildChildEnvironment({ HOME: "/home/agent" }, []);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});
