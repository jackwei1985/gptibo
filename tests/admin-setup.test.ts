import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseEnv } from 'node:util'
import { configureAdmin } from '../scripts/admin-setup.mjs'
import { validTotpSecret } from '../worker/totp.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'gptibo-admin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = join(root, 'services', 'storefront')
  await mkdir(join(backend, '.secrets'), { recursive: true })
  await writeFile(join(backend, '.env.example'), 'RELEASE_VERSION=local\nPUBLIC_ORIGIN=http://127.0.0.1:8093\n')
  await writeFile(join(backend, '.secrets', 'auth-secret'), randomBytes(32).toString('hex'))
  return { root, backend }
}

test('admin setup preserves existing settings and authenticator across reruns, keeping credentials private', async t => {
  const { root, backend } = await fixture(t)
  await writeFile(join(backend, '.env'), 'RELEASE_VERSION=custom\nPUBLIC_ORIGIN=http://127.0.0.1:8093\nADMIN_USERNAME=old\n')
  const result = await configureAdmin(root, { username: 'fixture-admin', email: 'ADMIN@example.test', mailMode: 'local' })
  const secretPath = join(backend, '.secrets', 'admin-totp')
  const secret = await readFile(secretPath, 'utf8')
  assert.ok(validTotpSecret(secret))
  const config = parseEnv(await readFile(join(backend, '.env'), 'utf8'))
  assert.equal(config.RELEASE_VERSION, 'custom')
  assert.equal(config.ADMIN_USERNAME, 'fixture-admin')
  assert.equal(config.ADMIN_EMAIL, 'admin@example.test')
  assert.equal(config.ADMIN_MAIL_MODE, 'local')
  assert.equal(config.ADMIN_TOTP_SECRET, undefined)
  const html = await readFile(result.setupPath, 'utf8')
  assert.ok(html.includes(secret))
  assert.match(html, /data:image\/png;base64,/)
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(result.composeArgs.includes('compose.dev-mail.yaml'))
  await configureAdmin(root, { username: 'fixture-admin', email: 'admin@example.test', mailMode: 'local' })
  assert.equal(await readFile(secretPath, 'utf8'), secret)
})

test('admin setup rejects malformed identities, public development mail and incomplete real mail before writing credentials', async t => {
  const { root, backend } = await fixture(t)
  for (const options of [
    { username: 'bad\nADMIN_EMAIL=other', email: 'admin@example.test' },
    { username: 'fixture-admin', email: 'bad\nvalue@example.test' },
    { username: 'fixture-admin', email: 'admin@example.test', mailMode: 'resend', mailFrom: 'sender@example.test' },
  ]) await assert.rejects(configureAdmin(root, options))
  await writeFile(join(backend, '.env'), 'PUBLIC_ORIGIN=https://shop.example.test\n')
  await assert.rejects(configureAdmin(root, { username: 'fixture-admin', email: 'admin@example.test', mailMode: 'local' }), /本机/)
  await assert.rejects(access(join(backend, '.secrets', 'admin-totp')))
  assert.equal(await readFile(join(backend, '.env'), 'utf8'), 'PUBLIC_ORIGIN=https://shop.example.test\n')
})
