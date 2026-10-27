import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getClaudeStatus, LOGIN_HINT } from "../src/claude-cli.ts";

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

test("auth status: JSON without a boolean loggedIn is a failure, not not-logged-in", async () => {
  await withFakeClaude(`#!/usr/bin/env node\nconsole.log(JSON.stringify({ok: 1}));\n`, async (command) => {
    const status = await getClaudeStatus(env(command));
    assert.match(status.detail ?? "", /^claude auth status failed: unparseable output/);
  });
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
