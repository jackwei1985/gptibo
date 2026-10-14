import { readdir, readFile } from 'node:fs/promises'

const directory = new URL('../.admin-auth/outbox/', import.meta.url)
try {
  const names = await readdir(directory)
  const messages = []
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
    const message = JSON.parse(await readFile(new URL(name, directory), 'utf8'))
    const age = Date.now() - Date.parse(message.createdAt)
    if (message.role === 'admin' && age >= 0 && age < 600_000 && /^\d{6}$/.test(message.code)) messages.push(message)
  }
  messages.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  if (!messages.length) console.log('没有 10 分钟内的管理员验证码，请先在后台点击获取验证码。')
  else {
    const message = messages[0]
    console.log(`本地开发收件箱（不发送真实邮件）\n收件人：${message.to}\n最新验证码：${message.code}\n创建时间：${message.createdAt}\n验证码仅对应最新一次请求，使用后失效。`)
  }
} catch (error) {
  console.error(error.code === 'ENOENT' ? '开发收件箱尚未创建，请先运行 npm run admin:setup -- --mail local。' : '无法读取开发收件箱。')
  process.exitCode = 1
}
