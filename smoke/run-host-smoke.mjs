/**
 * The foreign-host smoke test runner.
 *
 *   node smoke/run-host-smoke.mjs
 *
 * Copies the host app in smoke/host to a directory OUTSIDE this workspace, packs the
 * three packages into real tarballs, installs them there, then typechecks and builds
 * the host. Tarballs and an outside directory on purpose: a workspace link resolves
 * through this repo's node_modules and hides exactly the packaging bugs this exists
 * to catch — missing files, exports pointing at nothing, undeclared dependencies.
 *
 * The host deliberately mirrors the real consumer: React 19, R3F 9, three 0.169, its
 * own R3F canvas already on the page, resolve.dedupe for react, and hostile global
 * CSS. What this script proves ends at "it compiles and bundles"; the behavioural
 * half (CSS containment, storage namespacing, pack round-trip) is the Run smoke
 * checks button in the served page — `npm run preview` in the printed directory.
 */
import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const work = mkdtempSync(join(tmpdir(), 'gw-smoke-'))

const run = (cmd, cwd) => {
  console.log(`\n> ${cmd}  (${cwd})`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

console.log(`smoke host → ${work}`)
cpSync(join(repo, 'smoke', 'host'), work, { recursive: true })

run(
  'npm pack -w @dharv44/groundwork-core -w @dharv44/groundwork-engine -w @dharv44/groundwork-builder ' +
    `--pack-destination "${work}"`,
  repo,
)

run('npm install', work)
const tarballs = readdirSync(work)
  .filter((f) => f.endsWith('.tgz'))
  .map((f) => `"${join(work, f)}"`)
  .join(' ')
run(`npm install ${tarballs}`, work)

run('npm run check', work)
run('npm run build', work)

console.log(`\nsmoke host compiled and bundled from tarballs.`)
console.log(`for the in-browser half:  cd ${work} && npm run preview`)
