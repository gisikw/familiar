// Acceptance fixture only: real Familiar launcher, private tmux Presence and
// installed Pi. Never inherits resident descriptors, worklists, sockets or auth.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
export async function startIsolatedPresence({
  uiSource,
  origin,
  realProvider,
} = {}) {
  if (!process.env.PI_PACKAGE_DIR || process.env.FAMILIAR_SHELL !== "pi")
    throw new Error("run in Familiar's pinned pi dev shell");
  const root = mkdtempSync(join(tmpdir(), "background-presence-"));
  mkdirSync(join(root, "work"));
  const requests = [],
    held = new Map(),
    jobs = new Map(),
    events = new Set();
  let seq = 0;
  const publish = (job) => {
    const event = { seq: ++seq, job_id: job.id };
    for (const res of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/v1/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": attached\n\n");
      events.add(res);
      req.on("close", () => events.delete(res));
      return;
    }
    if (req.url === "/v1/capabilities") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          harnesses: { pi: { models: ["synthetic"] } },
          projects: [{ name: "test" }],
          clone_enabled: false,
        }),
      );
      return;
    }
    if (req.url?.startsWith("/v1/jobs")) {
      let text = "";
      for await (const chunk of req) text += chunk;
      const input = text ? JSON.parse(text) : {};
      let result;
      if (req.url === "/v1/jobs" && req.method === "POST") {
        result = [...jobs.values()].find(
          (job) => job.idempotency_key === input.idempotency_key,
        );
        if (!result) {
          result = {
            id: `child-${jobs.size + 1}`,
            idempotency_key: input.idempotency_key,
            state: "blocked",
            question: {
              id: "question",
              prompt: "Choose the branch-local target",
              options: ["safe"],
            },
            artifacts: input.artifacts,
          };
          jobs.set(result.id, result);
          publish(result);
        }
      } else if (req.url === "/v1/jobs") result = [...jobs.values()];
      else {
        const [, , , id, action] = req.url.split("/");
        result = jobs.get(id);
        if (
          result &&
          action === "artifacts" &&
          req.url.endsWith("/integration.txt")
        ) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Integrated test-integration");
          return;
        }
        if (result && action === "artifacts") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([{ path: "integration.txt", bytes: 27 }]));
          return;
        }
        if (result && action === "answer") {
          result.question.answer = input;
          result.state = "done";
          result.settlement = {
            summary: "Child integrated",
            ref: "test-integration",
          };
          publish(result);
        }
        if (result && action === "cancel") {
          result.state = "cancelled";
          result.settlement = { summary: "Cancelled" };
          publish(result);
        }
      }
      res.writeHead(result ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result ?? {}));
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    requests.push(request);
    const branch = request.tools?.some(
      (tool) => tool.function?.name === "background_report",
    );
    const user = JSON.stringify(
      request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "",
    );
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `request-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const done = () => {
      frame({}, "stop");
      res.end("data: [DONE]\n\n");
    };
    const tool = (name, args) => {
      frame({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${requests.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      frame({}, "tool_calls");
      res.end("data: [DONE]\n\n");
    };
    if (
      branch &&
      request.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("child review"),
      )
    ) {
      const job = [...jobs.values()][0];
      let last = {};
      try {
        last = JSON.parse(
          request.messages.filter((message) => message.role === "tool").at(-1)
            ?.content ?? "{}",
        );
      } catch {
        /* no prior result */
      }
      if (!job)
        tool("agents_dispatch", {
          key: "reviewed",
          harness: "pi",
          model: "synthetic",
          workspace: { project: "test", worktree: "background-review" },
          prompt: "Harmless review/integration fixture",
        });
      else if (!job.question.answer)
        tool("agents_owned", {
          action: "answer",
          jobId: job.id,
          questionId: "question",
          key: "answer",
          text: "safe",
        });
      else if (
        !request.messages.some(
          (message) =>
            message.role === "tool" &&
            JSON.stringify(message.content).includes(
              "Integrated test-integration",
            ),
        )
      )
        tool("agents_owned", {
          action: "artifact",
          jobId: job.id,
          path: "integration.txt",
        });
      else if (typeof last.reviewSeq === "number")
        tool("agents_owned", {
          action: "review",
          jobId: job.id,
          seq: last.reviewSeq,
        });
      else if (last.reviewed || last.reviewSeq === null)
        tool("background_report", {
          reportId: `review-${requests.length}`,
          disposition: "ready",
          summary: "Child reviewed and integrated",
          integrationRef: "test-integration",
          requestedRejoin: true,
        });
      else tool("agents_owned", { action: "status", jobId: job.id });
      return;
    }
    if (!branch && user.includes("handsfree sibling")) {
      frame({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `read-${requests.length}`,
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: join(root, "sentinel.txt") }),
            },
          },
          {
            index: 1,
            id: `background-${requests.length}`,
            type: "function",
            function: { name: "background", arguments: "{}" },
          },
        ],
      });
      frame({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (!branch && user.includes("handsfree")) {
      tool("background", {});
      return;
    }
    if (
      branch &&
      user.includes("children") &&
      !request.messages.some((m) => m.role === "tool")
    ) {
      tool("agents_dispatch", {
        key: "owned",
        harness: "pi",
        model: "synthetic",
        workspace: { project: "test", worktree: "background-test" },
        prompt: "Harmless owned child",
      });
      return;
    }
    if (branch && (user.includes("hold") || user.includes("children"))) {
      const key = requests.length;
      frame({ role: "assistant", content: "Background stream active" });
      held.set(key, done);
      res.on("close", () => held.delete(key));
      return;
    }
    if (branch && user.includes("plain refusal")) {
      frame({
        role: "assistant",
        content: "I cannot choose a target without clarification.",
      });
      done();
      return;
    }
    if (branch) {
      tool("background_report", {
        reportId: `report-${requests.length}`,
        disposition: "refused",
        summary: "Choose a target before proceeding",
        questions: ["Which target?"],
        requestedRejoin: true,
      });
      return;
    }
    frame({ role: "assistant", content: "READY" });
    done();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, "sentinel.txt"), "MUST_NOT_READ_FOREGROUND");
  const provider = join(root, "provider.ts");
  const witness = join(root, "witness.ts");
  writeFileSync(
    witness,
    `import { writeFileSync } from 'node:fs'; export default function(pi) { pi.on('session_start', (_event, ctx) => { writeFileSync(${JSON.stringify(join(root, "worker.pid"))}, String(process.pid)); writeFileSync(${JSON.stringify(join(root, "session.path"))}, ctx.sessionManager.getSessionFile()); }); }`,
  );
  writeFileSync(
    provider,
    `export default function(pi) { pi.registerProvider("fixture", { baseUrl: "${endpoint}/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "synthetic", name: "Synthetic", reasoning: false, input: ["text", "image"], contextWindow: 32768, maxTokens: 1024, cost: {input:0, output:0, cacheRead:0, cacheWrite:0} }] }); }`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(FAMILIAR_|PI_|GOLEM_|LLAMA_|ANTHROPIC_|OPENAI_)/.test(key),
    ),
  );
  Object.assign(env, {
    FAMILIAR_SHELL: "pi",
    PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
    FAMILIAR_REPO: repo,
    FAMILIAR_CONFIG_PATH: join(root, "familiar.toml"),
    FAMILIAR_PRESENCE_STATE_DIR: join(root, "presence"),
    FAMILIAR_PRESENCE_SOCKET: join(root, "presence/tmux.sock"),
    FAMILIAR_PRESENCE_CWD: join(root, "work"),
    PI_CODING_AGENT_DIR: join(root, "state/pi"),
    FAMILIAR_BACKGROUND_STATE_DIR: join(root, "state/background"),
    FAMILIAR_BACKGROUND_ENABLE: "1",
    FAMILIAR_BACKGROUND_PROVIDER_EXTENSION: realProvider?.adapter ?? provider,
    FAMILIAR_DEFAULT_PROVIDER: realProvider?.provider ?? "fixture",
    FAMILIAR_DEFAULT_MODEL: realProvider?.model ?? "synthetic",
    FAMILIAR_SUBSCRIBER_PORT: "0",
    GOLEM_ENDPOINT: endpoint,
    FAMILIAR_UI_DESCRIPTOR: join(root, "bridge.json"),
    FAMILIAR_UI_ORIGIN: origin ?? "http://localhost:5173",
    FAMILIAR_UI_ATTACHMENT_DIR: join(root, "attachments"),
    FAMILIAR_PI_EXTRA_EXTENSIONS_JSON: JSON.stringify([
      realProvider?.adapter ?? provider,
      witness,
      join(repo, "contrib/familiar/pi/agents/index.ts"),
      join(resolve(uiSource), "packages/extension/src/index.ts"),
    ]),
  });
  if (realProvider)
    for (const key of [
      "GOLEM_TIAMAT_URL",
      "GOLEM_TIAMAT_TOKEN_FILE",
      "GOLEM_TIAMAT_SNAPSHOT_FILE",
    ])
      env[key] = realProvider[key] ?? process.env[key];
  writeFileSync(
    env.FAMILIAR_CONFIG_PATH,
    "# Isolated acceptance instance; no private/resident configuration.\n",
    { mode: 0o600 },
  );
  const control = (...args) =>
    execFileSync(
      "bash",
      [join(repo, "services/presence/presence.sh"), ...args],
      { env, cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 20000 },
    );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const pid = existsSync(join(root, "worker.pid"))
      ? Number(readFileSync(join(root, "worker.pid"), "utf8"))
      : null;
    try {
      control("stop");
      if (pid) {
        for (let n = 0; n < 750; n++) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already drained */
        }
      }
    } finally {
      for (const finish of [...held.values()]) finish();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    control("ensure");
    for (let n = 0; n < 1000; n++) {
      if (existsSync(env.FAMILIAR_UI_DESCRIPTOR)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!existsSync(env.FAMILIAR_UI_DESCRIPTOR)) {
      // Synthetic prompts only; real-provider failures never dump a pane.
      if (!realProvider)
        console.error(
          execFileSync(
            "tmux",
            [
              "-S",
              env.FAMILIAR_PRESENCE_SOCKET,
              "capture-pane",
              "-p",
              "-S",
              "-60",
            ],
            { env, encoding: "utf8" },
          ),
        );
      throw new Error("isolated Presence birth did not publish UI descriptor");
    }
    return {
      root,
      env,
      descriptor: JSON.parse(readFileSync(env.FAMILIAR_UI_DESCRIPTOR, "utf8")),
      requests,
      jobs,
      foregroundEntries() {
        return readFileSync(
          readFileSync(join(root, "session.path"), "utf8"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map(JSON.parse);
      },
      foregroundDeliveries() {
        const relay = join(root, "state/pi/golem-settlement");
        return {
          present: existsSync(join(relay, "owned")),
          files: ["owned", "pending", "blocked"].flatMap((name) => {
            const dir = join(relay, name);
            return existsSync(dir) ? readdirSync(dir) : [];
          }),
          worklist: existsSync(join(root, "state/worklist/incoming"))
            ? readdirSync(join(root, "state/worklist/incoming"))
            : [],
        };
      },
      held,
      stop,
      control,
      async newSession() {
        const old = JSON.parse(
          readFileSync(env.FAMILIAR_UI_DESCRIPTOR, "utf8"),
        );
        execFileSync(
          "tmux",
          [
            "-S",
            env.FAMILIAR_PRESENCE_SOCKET,
            "send-keys",
            "-t",
            "presence:0.0",
            "-l",
            "/new",
          ],
          { env },
        );
        execFileSync(
          "tmux",
          [
            "-S",
            env.FAMILIAR_PRESENCE_SOCKET,
            "send-keys",
            "-t",
            "presence:0.0",
            "Enter",
          ],
          { env },
        );
        for (let n = 0; n < 1000; n++) {
          try {
            const next = JSON.parse(
              readFileSync(env.FAMILIAR_UI_DESCRIPTOR, "utf8"),
            );
            if (next.epoch !== old.epoch) return next;
          } catch {
            /* replacement */
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("isolated session replacement deadline");
      },
      async restart() {
        const old = JSON.parse(
          readFileSync(env.FAMILIAR_UI_DESCRIPTOR, "utf8"),
        );
        process.kill(
          Number(readFileSync(join(root, "worker.pid"), "utf8")),
          "SIGKILL",
        );
        for (let n = 0; n < 1000; n++) {
          try {
            const next = JSON.parse(
              readFileSync(env.FAMILIAR_UI_DESCRIPTOR, "utf8"),
            );
            if (next.epoch !== old.epoch) return next;
          } catch {
            /* rebirth */
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("isolated restart deadline");
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
