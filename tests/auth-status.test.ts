import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getClaudeStatus, LOGIN_HINT, runClaudeRequest } from "../src/claude-cli.ts";
import { createClaudeCodeProvider } from "../src/provider.ts";

async function withFakeClaude(script: string, run: (command: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-auth-"));
  const executable = join(root, "fake-claude");
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  try {
    await run(executable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const env = (command: string) => ({ PATH: process.env.PATH, HOME: process.env.HOME, PI_CLAUDE_CODE_COMMAND: command });

test("auth status: parsed loggedIn=false reports LOGIN_HINT", async () => {
  await withFakeClaude(
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({loggedIn: false}));\nprocess.exit(1);\n`,
    async (command) => {
      const status = await getClaudeStatus(env(command));
      assert.equal(status.available, true);
      assert.equal(status.loggedIn, false);
      assert.equal(status.detail, LOGIN_HINT);
    },
  );
});

test("auth status: parsed loggedIn=true is logged in", async () => {
  await withFakeClaude(
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "max"}));\n`,
    async (command) => {
      const status = await getClaudeStatus(env(command));
      assert.equal(status.loggedIn, true);
      assert.equal(status.subscription, true);
      assert.equal(status.plan, "max");
      assert.equal(status.detail, undefined);
    },
  );
});

test("auth status: non-zero exit reports exit code and stderr tail, not LOGIN_HINT", async () => {
  await withFakeClaude(
    `#!/usr/bin/env node\nprocess.stderr.write("Error: ENOENT: uv_cwd\\n");\nprocess.exit(7);\n`,
    async (command) => {
      const status = await getClaudeStatus(env(command));
      assert.equal(status.loggedIn, false);
      assert.notEqual(status.detail, LOGIN_HINT);
      assert.match(status.detail ?? "", /^claude auth status failed: exit code 7: Error: ENOENT: uv_cwd$/);
    },
  );
});

test("auth status: bad JSON reports unparseable output", async () => {
  await withFakeClaude(`#!/usr/bin/env node\nconsole.log("{not json");\n`, async (command) => {
    const status = await getClaudeStatus(env(command));
    assert.equal(status.loggedIn, false);
    assert.match(status.detail ?? "", /^claude auth status failed: unparseable output: \{not json$/);
  });
});

test("auth status: JSON without a boolean loggedIn is a failure that does not echo the body", async () => {
  await withFakeClaude(
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({email: "a@b.example", orgId: "org-123"}));\n`,
    async (command) => {
      const status = await getClaudeStatus(env(command));
      assert.equal(status.detail, "claude auth status failed: unexpected output (no loggedIn field)");
    },
  );
});

test("auth status: non-zero exit with JSON body and no stderr does not echo the body", async () => {
  await withFakeClaude(
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({email: "a@b.example"}));\nprocess.exit(3);\n`,
    async (command) => {
      const status = await getClaudeStatus(env(command));
      assert.equal(status.detail, "claude auth status failed: exit code 3");
    },
  );
});

test("auth status: spawn error reports error.message", async () => {
  await withFakeClaude(`#!/nonexistent/interpreter\n`, async (command) => {
    const status = await getClaudeStatus(env(command));
    assert.equal(status.available, true);
    assert.equal(status.loggedIn, false);
    assert.match(status.detail ?? "", /^claude auth status failed: .*ENOENT/);
  });
});

test("auth status: death by signal reports the signal", async () => {
  await withFakeClaude(`#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\nsetTimeout(() => {}, 5000);\n`, async (command) => {
    const status = await getClaudeStatus(env(command));
    assert.match(status.detail ?? "", /^claude auth status failed: Claude Code exited from signal SIGTERM$/);
  });
});

const failingClaude = `#!/usr/bin/env node\nprocess.stderr.write("Error: ENOENT: uv_cwd\\n");\nprocess.exit(7);\n`;
const failingDetail = "claude auth status failed: exit code 7: Error: ENOENT: uv_cwd";
const sleepingClaude = `#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n`;

test("auth status: stderr tail is capped at 500 characters", async () => {
  await withFakeClaude(
    `#!/usr/bin/env node\nprocess.stderr.write("a".repeat(1500) + "b".repeat(500));\nprocess.exit(1);\n`,
    async (command) => {
      const status = await getClaudeStatus(env(command));
      const prefix = "claude auth status failed: exit code 1: ";
      assert.equal(status.detail, prefix + "b".repeat(500));
      assert.equal(status.detail!.length, prefix.length + 500);
    },
  );
});

test("auth status: timeout reports 'timed out after Nms'", async () => {
  await withFakeClaude(sleepingClaude, async (command) => {
    const status = await getClaudeStatus(env(command), undefined, 300);
    assert.equal(status.detail, "claude auth status failed: timed out after 300ms");
  });
});

test("auth status: abort mid-check throws AbortError, not a failed status", async () => {
  await withFakeClaude(sleepingClaude, async (command) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await assert.rejects(getClaudeStatus(env(command), controller.signal), (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      return true;
    });
    assert.ok(Date.now() - started < 5000);
  });
});

test("auth status: request path (readyClaudeCommand) surfaces the failure detail, not LOGIN_HINT", async () => {
  await withFakeClaude(failingClaude, async (command) => {
    await assert.rejects(
      runClaudeRequest({
        model: "sonnet",
        frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }],
        systemPrompt: "",
        manifest: [],
        extraBody: {},
        toolNames: new Set(),
        env: env(command),
        retryBaseDelayMs: 1,
      }),
      (error: unknown) => {
        assert.equal((error as Error).message, failingDetail);
        return true;
      },
    );
  });
});

test("auth status: oauth refresh surfaces the failure detail, not LOGIN_HINT", async () => {
  await withFakeClaude(failingClaude, async (command) => {
    const provider = createClaudeCodeProvider();
    const signal = new AbortController().signal;
    const check = await provider.auth.apiKey?.check?.({
      ctx: {
        env: async (name) => (name === "PI_CLAUDE_CODE_COMMAND" ? command : undefined),
        fileExists: async () => false,
      },
      signal,
    });
    assert.equal(check, undefined);
    await assert.rejects(provider.auth.oauth!.refresh!({} as never, signal), (error: unknown) => {
      assert.equal((error as Error).message, failingDetail);
      return true;
    });
  });
});
