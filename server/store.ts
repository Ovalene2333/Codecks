import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Provider, PublicProvider } from './types.js'
import { CcSwitchSource, findCcSwitchDb } from './cc-switch.js'

const colors = ['#8b5cf6', '#38bdf8', '#f59e0b', '#22c55e', '#f43f5e']

export class ProviderStore {
  private providers: Provider[] = []
  private file: string
  private cc?: CcSwitchSource
  private ccSignature = ''

  constructor(private dataDir: string, private inheritedCodexHome?: string) {
    this.file = path.join(dataDir, 'providers.json')
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true })
    try {
      this.providers = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
      this.providers = [{
        id: 'local', name: '本机 Codex', kind: 'local-profile', color: colors[0],
        codexHome: this.inheritedCodexHome, enabled: true,
      }]
      await this.save()
    }
    const db = await findCcSwitchDb(process.env.CC_SWITCH_DB)
    if (db) { this.cc = new CcSwitchSource(db); await this.syncCcSwitch(true) }
    await this.addExistingCodexHomes()
  }

  private async addExistingCodexHomes() {
    const homes = new Map<string, { id: string; name: string }>()
    const nativeHome = this.inheritedCodexHome || path.join(os.homedir(), '.codex')
    homes.set(nativeHome, { id: 'local', name: process.env.WSL_DISTRO_NAME ? `WSL · ${process.env.WSL_DISTRO_NAME}` : '本机 Codex' })
    if (process.platform !== 'win32') {
      try {
        for (const user of await readdir('/mnt/c/Users')) {
          const home = path.join('/mnt/c/Users', user, '.codex')
          try { await access(path.join(home, 'sessions')); homes.set(home, { id: `windows-${user.toLowerCase()}`, name: `Windows · ${user}` }) } catch {}
        }
      } catch {}
    }
    const retained = this.providers.filter((p) => p.kind !== 'local-profile')
    const localProviders: Provider[] = []
    for (const [codexHome, meta] of homes) {
      try {
        await access(codexHome)
        localProviders.push({ id: meta.id, name: meta.name, kind: 'local-profile', color: colors[localProviders.length % colors.length], codexHome, enabled: true })
      } catch {}
    }
    this.providers = [...localProviders, ...retained]
  }

  async syncCcSwitch(force = false) {
    if (!this.cc) return false
    const synced = this.cc.readProviders()
    const signature = JSON.stringify(synced)
    if (!force && signature === this.ccSignature) return false
    this.ccSignature = signature
    this.providers = [...this.providers.filter((p) => p.kind !== 'cc-switch'), ...synced]
    return true
  }

  get ccSwitchPath() { return this.cc?.dbPath }

  listPublic(): PublicProvider[] {
    return this.providers.map(({ apiKey, configToml, authJson, ...item }) => ({ ...item, hasApiKey: Boolean(apiKey) || Boolean(authJson) }))
  }

  get(id: string) { return this.providers.find((p) => p.id === id) }

  async upsert(input: Partial<Provider> & { name: string; kind: Provider['kind'] }) {
    const old = input.id ? this.get(input.id) : undefined
    const provider: Provider = {
      id: old?.id ?? randomUUID(),
      name: input.name.trim(),
      kind: input.kind,
      color: input.color || old?.color || colors[this.providers.length % colors.length],
      model: input.model?.trim() || old?.model,
      baseUrl: input.baseUrl?.trim().replace(/\/$/, '') || old?.baseUrl,
      apiKey: input.apiKey || old?.apiKey,
      wireApi: input.wireApi || old?.wireApi || 'responses',
      codexHome: input.codexHome?.trim() || old?.codexHome,
      enabled: input.enabled ?? old?.enabled ?? true,
    }
    if (provider.kind === 'custom' && (!provider.baseUrl || !provider.model || !provider.apiKey)) {
      throw new Error('自定义供应商需要 Base URL、模型和 API Key')
    }
    const index = this.providers.findIndex((p) => p.id === provider.id)
    if (index >= 0) this.providers[index] = provider
    else this.providers.push(provider)
    await this.save()
    return provider
  }

  async remove(id: string) {
    const provider = this.get(id)
    if (!provider || provider.kind === 'local-profile') throw new Error('本机供应商不可删除')
    this.providers = this.providers.filter((p) => p.id !== id)
    await this.save()
  }

  private async save() {
    await writeFile(this.file, JSON.stringify(this.providers, null, 2), { encoding: 'utf8', mode: 0o600 })
  }
}
