import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { baseFor, changedSince, checkCiFiles, checkFiles, formatPlan, planCheck, recordCiBase } from "./check.js";
import { mapBase } from "./map.js";
import { recordsDirOf } from "./profile.js";
import { adapt, writeCalibration } from "./adapt.js";
export const CHECK_USAGE = `commons check <mode> [options]

Modes:
  map [--packages a,b] [--force]       Record the base at HEAD: declaration surfaces and function-coverage maps
  plan <files...> | --since <rev>      Print what a check would run and why (builds and runs nothing)
  related <files...>                   Check what the changed files need (build, type check, selected tests)
  ci <files...>                        Build, type-check and run affected packages' full suites
  ci-base [package dirs...]            Record full-suite base failures at HEAD, including dependents (skips records/maps)
  since [<rev>]                        Check everything changed since <rev> (default: the nearest recorded base)

Options:
  --repo <dir>       Repository (default: the current directory)
  --records <dir>    Records directory (default: COMMONS_VERIFY_DIR, the profile's, else ~/.commons/verify/<root commit>)
  --base <rev>       Compare against this recorded base instead of the nearest one
  --json             plan: print JSON

Python projects use pytest when available, else unittest discovery. Set COMMONS_PYTHON to override the interpreter
(default: the project's .venv/bin/python or venv/bin/python, else python3).
`;
/** Where records live for a repository (see recordsDirOf in profile.ts). */
export function recordsDirFor(repo, flag) {
    return recordsDirOf(repo, flag);
}
export const ADAPT_USAGE = `commons adapt [--repo <dir>] [--ai] [--model <m>] [--validate] [--map]

Learn how this repository builds, type-checks and tests, and write it to .commons/project.json (the project profile
every check reads). Without --ai the profile follows from rules; with --ai a model reviews it, reading the repository,
and notes each decision. --validate runs a check of the last code commit with the profile (one repair round with
--ai); --map then records the base (declaration surfaces, function-coverage maps) at HEAD.
`;
export async function adaptCommand(args, io) {
    const { values } = parseArgs({
        args,
        options: { repo: { type: "string" }, ai: { type: "boolean" }, model: { type: "string" }, validate: { type: "boolean" }, map: { type: "boolean" }, help: { type: "boolean" } },
    });
    if (values.help) {
        io.stdout.write(ADAPT_USAGE);
        return 0;
    }
    const repo = resolve(values.repo ?? process.cwd());
    const log = (l) => io.stderr.write(`[adapt] ${l}\n`);
    const r = await adapt(repo, { ai: values.ai, ...(values.model ? { model: values.model } : {}), validate: values.validate, log });
    io.stdout.write(`profile written to ${r.path}${r.costUsd ? ` (review $${r.costUsd.toFixed(2)})` : ""}\n${JSON.stringify(r.profile, null, 2)}\n`);
    if (r.validation)
        io.stdout.write(`validation: ${r.validation.ok ? "passed" : "FAILED"}${r.validation.commit ? ` (last code commit ${r.validation.commit.slice(0, 12)})` : ""}\n`);
    if (values.map && (!r.validation || r.validation.ok)) {
        const m = await mapBase({ repo, log });
        io.stdout.write(`base ${m.base}: ${m.surfaces} declaration surface(s), ${m.maps.length} coverage map(s)${m.skipped.length ? `; no map for ${m.skipped.join(", ")}` : ""}\n`);
        writeCalibration(repo, recordsDirOf(repo), m.base, log);
    }
    return r.validation && !r.validation.ok ? 1 : 0;
}
export async function checkCommand(args, io) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            repo: { type: "string" },
            records: { type: "string" },
            base: { type: "string" },
            since: { type: "string" },
            packages: { type: "string" },
            force: { type: "boolean" },
            json: { type: "boolean" },
        },
    });
    const [mode, ...rest] = positionals;
    const repo = resolve(values.repo ?? process.cwd());
    const recordsDir = recordsDirFor(repo, values.records);
    const log = (l) => io.stderr.write(`[check] ${l}\n`);
    const opts = { recordsDir, base: values.base ?? null };
    switch (mode) {
        case "map": {
            const r = await mapBase({ repo, packages: values.packages?.split(",").map((p) => p.trim()).filter(Boolean), recordsDir, force: values.force, log });
            io.stdout.write(`base ${r.base}: ${r.surfaces} declaration surface(s), ${r.maps.length} coverage map(s)${r.skipped.length ? `; no map for ${r.skipped.join(", ")}` : ""}\nrecords in ${recordsDir}\n`);
            return 0;
        }
        case "plan": {
            const files = values.since ? await changedSince(repo, values.since) : rest;
            const plan = await planCheck(repo, files, opts);
            io.stdout.write(values.json ? `${JSON.stringify(plan, null, 2)}\n` : `${formatPlan(plan)}\n`);
            return 0;
        }
        case "related":
            return checkFiles(repo, rest, log, opts);
        case "ci":
            return checkCiFiles(repo, rest, log, opts);
        case "ci-base":
            return recordCiBase(repo, rest.length ? rest : values.packages?.split(",").filter(Boolean) ?? [], log, { recordsDir });
        case "since": {
            const base = rest[0] ?? baseFor(repo, opts);
            return checkFiles(repo, await changedSince(repo, base), log, opts);
        }
        default:
            io.stderr.write(CHECK_USAGE);
            return 2;
    }
}
//# sourceMappingURL=cli.js.map