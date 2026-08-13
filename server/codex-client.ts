import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import type { Provider, RpcMessage } from './types.js'

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const toml = (value: string) => JSON.stringify(value)

export interface LaunchSpec { command: string; args: string[] }

export function codexLaunchSpec(bin = 'codex', platform = process.platform, env: NodeJS.ProcessEnv = process.env): LaunchSpec {
  const appArgs = ['app-server', '--stdio']
  if (platform !== 'win32' || /\.exe$/i.test(bin)) return { command: bin, args: appArgs }
  const shell = env.ComSpec || env.COMSPEC || 'cmd.exe'
  if (/[\r\n]/.test(bin)) throw new Error('CODEX_BIN 不能包含换行符')
  const executable = /[\s&()^%!]/.test(bin) ? `"${bin.replace(/"/g, '""')}"` : bin
  return { command: shell, args: ['/d', '/s', '/c', `${executable} app-server --stdio`] }
}

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private nextId = 1
  private starting?: Promise<void>
  online = false
  lastError?: string
  private stderr = ''
  private failed = false
  private stopping = false

  constructor(
    readonly provider: Provider,
    private dataDir: string,
    private codexBin = 'codex',
  ) { super() }

  async start() {
    if (this.online) return
    if (this.starting) return this.starting
    this.starting = this.doStart().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async doStart() {
    const env = { ...process.env }
    if (this.provider.kind === 'cc-switch') {
      const home = path.join(this.dataDir, 'homes', this.provider.id)
      await mkdir(home, { recursive: true })
      await writeFile(path.join(home, 'config.toml'), this.provider.configToml || '', { encoding: 'utf8', mode: 0o600 })
      await writeFile(path.join(home, 'auth.json'), JSON.stringify(this.provider.authJson || {}, null, 2), { encoding: 'utf8', mode: 0o600 })
      env.CODEX_HOME = home
      if (this.provider.apiKey) env.OPENAI_API_KEY = this.provider.apiKey
    } else if (this.provider.kind === 'custom') {
      const home = path.join(this.dataDir, 'homes', this.provider.id)
      await mkdir(home, { recursive: true })
      const config = [
        `model = ${toml(this.provider.model!)}`,
        `model_provider = "deck_provider"`,
        '', '[model_providers.deck_provider]',
        `name = ${toml(this.provider.name)}`,
        `base_url = ${toml(this.provider.baseUrl!)}`,
        `env_key = "CODEX_DECK_PROVIDER_KEY"`,
        `wire_api = ${toml(this.provider.wireApi || 'responses')}`,
      ].join('\n') + '\n'
      await writeFile(path.join(home, 'config.toml'), config, { encoding: 'utf8', mode: 0o600 })
      env.CODEX_HOME = home
      env.CODEX_DECK_PROVIDER_KEY = this.provider.apiKey!
    } else if (this.provider.codexHome) {
      env.CODEX_HOME = this.provider.codexHome
    }

    const launch = codexLaunchSpec(this.codexBin, process.platform, env)
    this.stderr = ''
    this.failed = false
    this.stopping = false
    this.child = spawn(launch.command, launch.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.once('error', (error) => this.fail(error))
    this.child.once('exit', (code) => { if (!this.stopping) this.fail(new Error(`Codex app-server 已退出 (${code ?? 'unknown'})`)) })
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      this.stderr = `${this.stderr}${text}`.slice(-8_000)
      this.emit('log', text)
    })
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      try { this.handle(JSON.parse(line)) } catch { this.emit('log', `无法解析 app-server 输出: ${line}`) }
    })
    await this.request('initialize', {
      clientInfo: { name: 'codex-deck', title: 'Codex Deck', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized')
    this.online = true
    this.lastError = undefined
    this.emit('online')
  }

  async request(method: string, params?: any, timeout = 20_000): Promise<any> {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server 未运行')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 请求超时`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }

  notify(method: string, params?: any) { this.send({ method, ...(params === undefined ? {} : { params }) }) }

  respond(id: number | string, result: any) { this.send({ id, result }) }

  stop() {
    this.stopping = true
    this.child?.kill()
    this.child = undefined
    this.online = false
  }

  private send(message: RpcMessage) { this.child?.stdin.write(`${JSON.stringify(message)}\n`) }

  private handle(message: RpcMessage) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(Number(message.id))
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) this.emit('request', message)
    else if (message.method) this.emit('notification', message)
  }

  private fail(error: Error) {
    if (this.failed) return
    this.failed = true
    this.online = false
    const detail = this.stderr.trim().split(/\r?\n/).slice(-6).join('\n')
    const wrapped = new Error(`${error.message}${detail ? `\n${detail}` : ''}`)
    this.lastError = wrapped.message
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(wrapped) }
    this.pending.clear()
    this.emit('offline', wrapped.message)
  }
}
