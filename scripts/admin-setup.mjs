import { readFile, open } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import QRCode from 'qrcode'
import { generateTotpSecret, validTotpSecret } from '../worker/totp.ts'
import { ensurePrivateDirectory, protectPrivatePath, writePrivateFile } from './private-files.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

async function optionalText(path) {
  try { return await readFile(path, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error }
}

function updateSettings(source, settings) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  for (const [key, value] of Object.entries(settings)) {
    // Single quotes prevent Compose from expanding dollar signs in settings.
    if (/[\r\n\0'\\]/.test(value)) throw new Error(`Invalid characters in ${key}`)
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
    const indexes = lines.flatMap((line, index) => pattern.test(line) ? [index] : [])
    const next = `${key}='${value}'`
    if (indexes.length) {
      lines[indexes[0]] = next
      for (const index of indexes.slice(1)) lines[index] = ''
    } else lines.push(next)
  }
  return lines.join('\n').trimEnd() + '\n'
}

export async function configureAdmin(root, { username, email, mailMode = 'none', mailFrom = '' }) {
  username = username.trim()
  email = email.trim().toLowerCase()
  mailFrom = mailFrom.trim()
  if (!/^[A-Za-z0-9_.@-]{1,80}$/.test(username)) throw new Error('用户名需为 1–80 位字母、数字或 _.@-。')
  if (!emailPattern.test(email) || email.length > 254) throw new Error('请输入有效的管理员邮箱。')
  if (!['local', 'resend', 'none'].includes(mailMode)) throw new Error('--mail 仅支持 local、resend、none。')
  const backend = join(root, 'services', 'storefront')
  const envPath = join(backend, '.env')
  const source = await optionalText(envPath) || await readFile(join(backend, '.env.example'), 'utf8')
  const existing = parseEnv(source)
  if (mailMode === 'local') {
    const origin = new URL(existing.PUBLIC_ORIGIN || 'http://127.0.0.1:8093')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('开发收件箱仅可用于本机 PUBLIC_ORIGIN。')
  }
  if (mailMode === 'resend') {
    const sender = mailFrom.match(/<([^<>]+)>$/)?.[1] || mailFrom
    if (!emailPattern.test(sender) || /[\r\n\0'\\]/.test(mailFrom)) throw new Error('Resend 模式需要有效的 --mail-from 发件地址。')
    if (!(await optionalText(join(backend, '.secrets', 'resend-key'))).trim()) throw new Error('请先将 Resend API Key 保存到 services/storefront/.secrets/resend-key。')
  }
  if (!/^[a-f0-9]{64}$/.test((await optionalText(join(backend, '.secrets', 'auth-secret'))).trim())) {
    throw new Error('请先按照 README 初始化后端 .secrets/auth-secret。')
  }
  const secrets = join(backend, '.secrets')
  const privateDirectory = join(root, '.admin-auth')
  await ensurePrivateDirectory(secrets)
  await ensurePrivateDirectory(privateDirectory)
  if (mailMode === 'local') await ensurePrivateDirectory(join(privateDirectory, 'outbox'))
  const secretPath = join(secrets, 'admin-totp')
  let secret
  try {
    // Exclusive creation keeps an already bound authenticator unchanged.
    const file = await open(secretPath, 'wx', 0o600)
    try {
      await protectPrivatePath(secretPath)
      secret = generateTotpSecret()
      await file.writeFile(secret)
    } finally { await file.close() }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    secret = (await readFile(secretPath, 'utf8')).trim()
    if (!validTotpSecret(secret)) throw new Error('已有验证器密钥格式无效，未覆盖；请先检查 .secrets/admin-totp。')
    await protectPrivatePath(secretPath)
  }
  const settings = { ADMIN_USERNAME: username, ADMIN_EMAIL: email, ADMIN_MAIL_MODE: mailMode }
  if (mailMode === 'resend') settings.MAIL_FROM = mailFrom
  const uri = new URL(`otpauth://totp/${encodeURIComponent(`GPTibo:${username}`)}`)
  for (const [key, value] of Object.entries({ secret, issuer: 'GPTibo', algorithm: 'SHA1', digits: '6', period: '30' })) uri.searchParams.set(key, value)
  const qr = await QRCode.toDataURL(uri.href, { width: 320, errorCorrectionLevel: 'M' })
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>GPTibo 管理员验证器</title><style>body{max-width:620px;margin:48px auto;padding:24px;font:16px/1.7 system-ui}img{width:320px;max-width:100%}code{overflow-wrap:anywhere}small{color:#555}</style><h1>绑定管理员验证器</h1><p>用户名：<strong>${escapeHtml(username)}</strong><br>收码邮箱：${escapeHtml(email)}</p><p>使用 Google Authenticator、Microsoft Authenticator 等扫描二维码。</p><img src="${qr}" alt="管理员验证器绑定二维码"><p>手动录入密钥：<code>${secret}</code><br>时间型、SHA-1、6 位、30 秒</p><p><a href="${escapeHtml(uri.href)}">在验证器中打开</a></p><p>绑定后访问 <a href="http://127.0.0.1:5175/admin">本地管理后台</a>。</p><small>此文件包含验证器密钥，仅保存在本机；不要分享或上传。${mailMode === 'local' ? '开发邮箱验证码通过项目终端 npm run admin:inbox 查看，不会发往真实邮箱。' : ''}</small></html>`
  await writePrivateFile(join(privateDirectory, 'authenticator.png'), await QRCode.toBuffer(uri.href, { width: 320, errorCorrectionLevel: 'M' }))
  await writePrivateFile(join(privateDirectory, 'setup.html'), html)
  await writePrivateFile(envPath, updateSettings(source, settings))
  const composeArgs = ['compose', '-f', 'compose.yaml', '-f', 'compose.admin.yaml']
  if (mailMode === 'local') composeArgs.push('-f', 'compose.dev-mail.yaml')
  if (mailMode === 'resend') composeArgs.push('-f', 'compose.auth.yaml')
  return { backend, composeArgs, setupPath: join(privateDirectory, 'setup.html'), mailMode }
}

async function main() {
  const { values } = parseArgs({ options: { username: { type: 'string' }, email: { type: 'string' }, mail: { type: 'string' }, 'mail-from': { type: 'string' }, 'no-apply': { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log('Go + PostgreSQL 管理员初始化：\nnpm run admin:setup -- --username hands --email admin@example.invalid --mail local\n--mail local|resend|none  --mail-from 发件地址  --no-apply 只生成配置，不重启服务\n已有验证器密钥保持不变。默认交互输入；非交互环境需提供用户名和邮箱。')
    return
  }
  const existing = parseEnv(await optionalText(join(projectRoot, 'services', 'storefront', '.env')))
  let username = values.username || existing.ADMIN_USERNAME
  let email = values.email || existing.ADMIN_EMAIL
  let mailMode = values.mail || existing.ADMIN_MAIL_MODE
  let mailFrom = values['mail-from'] || existing.MAIL_FROM || ''
  if (process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    try {
      username ||= await prompt.question('管理员用户名：')
      email ||= await prompt.question('管理员收码邮箱：')
      mailMode ||= (await prompt.question('验证码方式（local 开发收件箱 / resend / none 暂不启用）：')).trim() || 'none'
      if (mailMode === 'resend' && !mailFrom) mailFrom = await prompt.question('Resend 发件地址 MAIL_FROM：')
    } finally { prompt.close() }
  }
  if (!username || !email) throw new Error('请提供 --username 和 --email，或在交互终端运行此命令。')
  const result = await configureAdmin(projectRoot, { username, email, mailMode, mailFrom })
  console.log(`管理员配置已保存，验证器密钥未打印。\n绑定页面：${result.setupPath}`)
  if (result.mailMode === 'local') console.log('已选择开发收件箱。点击获取验证码后运行 npm run admin:inbox 查看。')
  if (result.mailMode === 'none') console.log('邮件未启用，尚不能登录；配置邮件后重新运行初始化命令。')
  if (!values['no-apply']) {
    for (const args of [['config', '--quiet'], ['up', '-d', '--wait', 'api', 'worker']]) {
      const child = spawnSync('docker', [...result.composeArgs, ...args], { cwd: result.backend, stdio: 'inherit', windowsHide: true })
      if (child.error || child.status !== 0) throw new Error('Docker Compose 未完成，请检查上方错误后重新运行初始化命令。')
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
