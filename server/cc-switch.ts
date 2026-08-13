import { DatabaseSync } from 'node:sqlite'
import { access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Provider } from './types.js'

type Row = { id: string; name: string; settings_config: string; icon_color: string | null; is_current: number }

export async function findCcSwitchDb(explicit?: string) {
  const candidates = [explicit, process.env.CC_SWITCH_CONFIG_DIR && path.join(process.env.CC_SWITCH_CONFIG_DIR, 'cc-switch.db'), path.join(os.homedir(), '.cc-switch', 'cc-switch.db')].filter(Boolean) as string[]
  if (process.platform !== 'win32') {
    // WSL: Windows CC Switch usually stores its DB under /mnt/c/Users/<name>.
    const windowsUsers = '/mnt/c/Users'
    try {
      const { readdir } = await import('node:fs/promises')
      for (const user of await readdir(windowsUsers)) candidates.push(path.join(windowsUsers, user, '.cc-switch', 'cc-switch.db'))
    } catch {}
  }
  for (const candidate of candidates) try { await access(candidate); return candidate } catch {}
  return undefined
}

export class CcSwitchSource {
  constructor(readonly dbPath: string) {}

  readProviders(): Provider[] {
    const db = new DatabaseSync(this.dbPath, { readOnly: true })
    try {
      const rows = db.prepare("select id,name,settings_config,icon_color,is_current from providers where app_type='codex' order by sort_index").all() as unknown as Row[]
      return rows.map((row, index) => {
        const settings = JSON.parse(row.settings_config || '{}')
        const config = String(settings.config || '')
        return {
          id: `cc-${row.id}`, name: row.name, kind: 'cc-switch' as const,
          color: row.icon_color || ['#8b5cf6','#38bdf8','#f59e0b','#22c55e','#f43f5e'][index % 5],
          model: matchToml(config, 'model'), baseUrl: matchToml(config, 'base_url'),
          wireApi: matchToml(config, 'wire_api') === 'chat' ? 'chat' : 'responses',
          enabled: true, current: Boolean(row.is_current), configToml: config, authJson: settings.auth || {},
          apiKey: settings.auth?.OPENAI_API_KEY || undefined,
        }
      })
    } finally { db.close() }
  }
}

function matchToml(config: string, key: string) {
  const match = config.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'))
  return match?.[1]
}
