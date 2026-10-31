import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  alice,
  authBootstrap,
  briefFixture,
  documentFixture,
  persistenceMigration,
  previousMigrations,
} from "../tests/fixtures/site-persistence.ts";

// Intentionally no DATABASE_URL/PGHOST, host ports, mounts, or external network.
// Pin both the version and digest; this harness can only migrate its own container.
const image =
  "postgres:17-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5";
const container = `black-sales-site-tests-${randomUUID()}`;
const env = { ...process.env };
for (const key of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete env[key];
const docker = ["--host=unix:///var/run/docker.sock"];
const sessions = new Set();
let created = false;
function command(args, input = "", timeout = 60000) {
  const child = spawn("docker", [...docker, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = { stdout: "", stderr: "", code: null };
  child.stdout.setEncoding("utf8").on("data", (s) => (out.stdout += s));
  child.stderr.setEncoding("utf8").on("data", (s) => (out.stderr += s));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      out.code = code;
      sessions.delete(child);
      resolve(out);
    });
  });
  // A cancelled container can close stdin before the client finishes writing.
  child.stdin.on("error", () => {});
  sessions.add(child);
  if (input !== null) child.stdin.end(input);
  return { child, out, done };
}
async function run(args, input = "") {
  const result = await command(args, input).done;
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
const psqlArgs = [
  "exec",
  "-i",
  container,
  "psql",
  "-X",
  "-qAt",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-v",
  "ON_ERROR_STOP=1",
  "-v",
  "VERBOSITY=verbose",
];
const sql = (input) => run(psqlArgs, input);
const literal = (value) =>
  value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const call = (name, args) =>
  `select to_jsonb(public.${name}(${args.map(literal).join(",")}));\n`;
const identity = `set local role authenticated;set local "request.jwt.claim.sub"=${literal(alice)};`;
const transaction = (statement) => `begin;${identity}${statement}commit;`;
function jsonResult(output) {
  const line = output.split("\n").find((s) => s.startsWith("{"));
  assert.ok(line, `Missing JSON result: ${output}`);
  return JSON.parse(line);
}
const userCall = async (name, args) =>
  jsonResult(await sql(transaction(call(name, args))));
async function project() {
  const p = await userCall("studio_create_project", [
    "Projeto sintético concorrente",
    "demo",
    null,
    randomUUID(),
  ]);
  const v = await userCall("studio_save_brief", [
    p.project_id,
    p.version_id,
    JSON.stringify(briefFixture()),
    randomUUID(),
  ]);
  const detail = await userCall("studio_project_detail", [p.project_id, null]);
  const hash = detail.version.content_hash;
  await userCall("studio_approve_brief", [p.project_id, v.version_id, hash]);
  return { id: p.project_id, brief: v.version_id, hash };
}
const admission = (p, request = randomUUID()) =>
  call("studio_create_generation_job", [p.id, p.brief, p.hash, request]);
const completion = (job, doc = documentFixture()) =>
  call("studio_complete_generation_job", [
    job.id,
    job.attempt_id,
    JSON.stringify(doc),
  ]);
async function processing(p) {
  const job = jsonResult(await sql(transaction(admission(p))));
  return userCall("studio_start_generation_job", [job.id, randomUUID()]);
}
async function until(condition, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(25);
  }
  throw new Error(message);
}
// Hold A's transaction open, prove B is waiting on a PostgreSQL lock, then
// release A. These are independent backend PIDs, not serialized JS promises.
async function race(firstStatement, secondStatement, errorCode = null) {
  const suffix = randomUUID().replaceAll("-", "");
  const waitingName = `site_wait_${suffix}`;
  const a = command(psqlArgs, null);
  let b;
  try {
    a.child.stdin.write(
      `begin;${identity}${firstStatement}\\echo SITE_LOCK_READY\n`,
    );
    await until(() => {
      assert.equal(a.out.code, null, a.out.stderr);
      return a.out.stdout.includes("SITE_LOCK_READY");
    }, "First transaction did not become ready");
    b = command(
      psqlArgs,
      `set application_name=${literal(waitingName)};${transaction(secondStatement)}`,
    );
    await until(async () => {
      assert.equal(b.out.code, null, b.out.stderr);
      return (
        (await sql(
          `select count(*) from pg_stat_activity where application_name=${literal(waitingName)} and wait_event_type='Lock';`,
        )) === "1"
      );
    }, "Second transaction never waited on a real database lock");
    a.child.stdin.end("commit;\n\\q\n");
    const [first, second] = await Promise.all([a.done, b.done]);
    assert.equal(first.code, 0, first.stderr);
    if (errorCode) {
      assert.notEqual(second.code, 0, "Conflicting transaction must fail");
      assert.match(second.stderr, new RegExp(`ERROR:\\s+${errorCode}:`));
    } else assert.equal(second.code, 0, second.stderr);
    return [
      jsonResult(first.stdout),
      errorCode ? null : jsonResult(second.stdout),
    ];
  } finally {
    if (a.out.code === null) a.child.kill("SIGKILL");
    if (b?.out.code === null) b.child.kill("SIGKILL");
  }
}
async function count(table, projectId) {
  return Number(
    await sql(
      `select count(*) from public.${table} where project_id=${literal(projectId)};`,
    ),
  );
}
async function cleanup() {
  for (const child of sessions) child.kill("SIGKILL");
  if (created) {
    created = false;
    await run(["rm", "-f", container]);
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(1));
  });

try {
  await run([
    "run",
    "-d",
    "--name",
    container,
    "--label",
    "black-sales-ai.test=site-persistence",
    "--network",
    "none",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,nosuid,nodev",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    image,
  ]);
  created = true;
  await until(async () => {
    const r = await command([
      "exec",
      container,
      "sh",
      "-c",
      'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres',
    ]).done;
    return r.code === 0;
  }, "Temporary PostgreSQL did not start");
  await sql(authBootstrap);
  for (const file of [...previousMigrations, persistenceMigration])
    await sql(
      await readFile(
        new URL(`../supabase/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  await sql(
    `insert into auth.users values (${literal(alice)});insert into public.app_members values (${literal(alice)},true);`,
  );

  let p = await project();
  const request = randomUUID();
  const [a, b] = await race(admission(p, request), admission(p, request));
  assert.equal(a.id, b.id);
  assert.equal(await count("studio_generation_jobs", p.id), 1);
  console.log("PASS concurrent identical admission returns one job");

  p = await project();
  await race(admission(p), admission(p), "40001");
  assert.equal(await count("studio_generation_jobs", p.id), 1);
  console.log("PASS competing admission cannot create a second active job");

  p = await project();
  const job = jsonResult(await sql(transaction(admission(p))));
  await race(
    call("studio_start_generation_job", [job.id, randomUUID()]),
    call("studio_start_generation_job", [job.id, randomUUID()]),
    "40001",
  );
  console.log("PASS only one processing attempt can claim a pending job");

  p = await project();
  let running = await processing(p);
  const [v1, v2] = await race(completion(running), completion(running));
  assert.equal(v1.id, v2.id);
  assert.equal(await count("studio_site_versions", p.id), 1);
  console.log(
    "PASS duplicate completion appends exactly one immutable version",
  );

  p = await project();
  running = await processing(p);
  const changed = documentFixture();
  changed.pages[0].title = "Resultado concorrente diferente";
  await race(completion(running), completion(running, changed), "22023");
  assert.equal(await count("studio_site_versions", p.id), 1);
  console.log("PASS conflicting completion cannot replace the first result");

  p = await project();
  running = await processing(p);
  await race(
    call("studio_fail_generation_job", [
      running.id,
      running.attempt_id,
      "cancelled",
    ]),
    completion(running),
    "40001",
  );
  assert.equal(await count("studio_site_versions", p.id), 0);
  console.log(
    "PASS cancellation and completion serialize without partial output",
  );

  p = await project();
  const fields = briefFixture();
  fields.colors.value = "Azul";
  await race(
    call("studio_save_brief", [
      p.id,
      p.brief,
      JSON.stringify(fields),
      randomUUID(),
    ]),
    admission(p),
    "40001",
  );
  assert.equal(await count("studio_generation_jobs", p.id), 0);
  console.log("PASS concurrent briefing change prevents stale admission");
  console.log(
    "7 real PostgreSQL concurrency checks passed (temporary database only).",
  );
} finally {
  await cleanup();
}
