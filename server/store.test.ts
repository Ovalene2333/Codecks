import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProviderStore } from './store.js'

function seedCcSwitchDb(
  file: string,
  rows: Array<{ id: string; name: string; current?: number; baseUrl?: string }>,
) {
  const db = new DatabaseSync(file)
  db.exec(
    'create table if not exists providers (id text, app_type text, name text, settings_config text, icon_color text, is_current integer, sort_index integer)',
  )
  db.exec('delete from providers')
  const insert = db.prepare('insert into providers values (?, ?, ?, ?, ?, ?, ?)')
  rows.forEach((row, index) => {
    insert.run(
      row.id,
      'codex',
      row.name,
      JSON.stringify({
        auth: { OPENAI_API_KEY: 'secret' },
        config: `model = "gpt-test"\n[model_providers.custom]\nbase_url = "${row.baseUrl || 'https://example.test/v1'}"\nwire_api = "responses"`,
      }),
      null,
      row.current ?? 0,
      index,
    )
  })
  db.close()
}

async function withCcSwitchDb<T>(file: string, run: () => Promise<T>) {
  const previous = process.env.CC_SWITCH_DB
  process.env.CC_SWITCH_DB = file
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.CC_SWITCH_DB
    else process.env.CC_SWITCH_DB = previous
  }
}

test('provider secrets stay private and persist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-deck-'))
  const store = new ProviderStore(dir)
  await store.load()
  const saved = await store.upsert({ name: 'Test', kind: 'custom', baseUrl: 'https://example.test/v1/', model: 'test-model', apiKey: 'secret' })
  assert.equal(store.listPublic().find((p) => p.id === saved.id)?.hasApiKey, true)
  assert.equal((store.listPublic().find((p) => p.id === saved.id) as any).apiKey, undefined)
  assert.match(await readFile(path.join(dir, 'providers.json'), 'utf8'), /secret/)
  assert.equal(store.get(saved.id)?.baseUrl, 'https://example.test/v1')
})

test('the runtime codex home stays visible and loads as a provider', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-deck-'))
  // 本机入口始终存在，不依赖安装 CC Switch。
  const store = new ProviderStore(dir, dir)
  await store.load()

  const local = store.listPublic().find((p) => p.kind === 'local-profile')
  assert.equal(local?.id, 'local')
  assert.ok(store.runtimeProviders().some((p) => p.id === 'local'))
})

test('a local-profile row that is not the runtime home stays hidden', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-deck-'))
  const store = new ProviderStore(dir, dir)
  await store.load()
  const extra = await store.upsert({ name: 'Other home', kind: 'local-profile', codexHome: '/nonexistent' })

  assert.equal(store.listPublic().some((p) => p.id === extra.id), false)
  assert.equal(store.runtimeProviders().some((p) => p.id === extra.id), false)
})

test('without CC Switch the local provider survives a not-yet-created Codex home and stale imports', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deck-no-cc-switch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const home = path.join(dir, 'new-codex-home')
  await writeFile(path.join(dir, 'providers.json'), JSON.stringify([
    { id: 'cc-old', name: 'Stale import', kind: 'cc-switch', enabled: true, apiKey: 'old-secret' },
  ]))
  await withCcSwitchDb(path.join(dir, 'missing.db'), async () => {
    const store = new ProviderStore(dir, home)
    await store.load()
    assert.deepEqual(store.listPublic().map((provider) => provider.id), ['local'])
    assert.equal(store.runtimeProviders()[0].codexHome, home)
    assert.equal(store.ccSwitchPath, undefined)
    assert.deepEqual(store.claudeProfiles(), [])
  })
})

test('saving Deck providers never persists imported CC Switch credentials', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deck-import-isolation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const db = path.join(dir, 'cc-switch.db')
  seedCcSwitchDb(db, [{ id: 'relay', name: 'Imported' }])
  await withCcSwitchDb(db, async () => {
    const store = new ProviderStore(dir, path.join(dir, 'home'))
    await store.load()
    await store.upsert({ name: 'Deck relay', kind: 'custom', baseUrl: 'https://deck.test/v1', model: 'test-model', apiKey: 'deck-secret' })
    assert.ok(store.listPublic().some((provider) => provider.kind === 'cc-switch'))
    const saved = JSON.parse(await readFile(path.join(dir, 'providers.json'), 'utf8'))
    assert.equal(saved.some((provider: any) => provider.kind === 'cc-switch'), false)
    assert.equal(JSON.stringify(saved).includes('"secret"'), false)
    assert.equal(JSON.stringify(saved).includes('deck-secret'), true)
  })
})

test('runtime model context settings persist outside config.toml', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-deck-context-'))
  const store = new ProviderStore(dir)
  await store.load()
  await store.updateRuntimeModelConfig({
    modelContextWindow: 1_000_000,
    modelAutoCompactTokenLimit: 900_000,
  })

  const reloaded = new ProviderStore(dir)
  await reloaded.load()
  assert.deepEqual(reloaded.runtimeModelConfig(), {
    modelContextWindow: 1_000_000,
    modelAutoCompactTokenLimit: 900_000,
  })
  assert.match(
    await readFile(path.join(dir, 'runtime-config.json'), 'utf8'),
    /1000000/,
  )
})

test('runtime codex backend selection persists and survives model updates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-deck-bin-'))
  const store = new ProviderStore(dir)
  await store.load()
  assert.equal(store.runtimeCodexBin(), '')
  await store.updateRuntimeCodexBin('/opt/demo/bin/codex')
  assert.equal(store.runtimeCodexBin(), '/opt/demo/bin/codex')
  await store.updateRuntimeModelConfig({ modelContextWindow: 500_000 })
  // 模型设置写入不得丢掉后端选择。
  assert.equal(store.runtimeCodexBin(), '/opt/demo/bin/codex')
  const reloaded = new ProviderStore(dir)
  await reloaded.load()
  assert.equal(reloaded.runtimeCodexBin(), '/opt/demo/bin/codex')
})

test('Claude and OpenCode executable choices persist independently of Codex settings', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deck-agent-executables-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new ProviderStore(dir)
  await store.load()
  await store.updateRuntimeCodexBin('/opt/demo/bin/codex')
  await store.updateRuntimeAgentBin('claude', '/opt/demo/bin/claude')
  await store.updateRuntimeAgentBin('opencode', '/opt/demo/bin/opencode')
  await store.updateRuntimeModelConfig({ modelContextWindow: 500_000 })
  const reloaded = new ProviderStore(dir)
  await reloaded.load()
  assert.equal(reloaded.runtimeCodexBin(), '/opt/demo/bin/codex')
  assert.equal(reloaded.runtimeAgentBin('claude'), '/opt/demo/bin/claude')
  assert.equal(reloaded.runtimeAgentBin('opencode'), '/opt/demo/bin/opencode')
})

test('refreshCcSwitch rediscovers a newly available database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-deck-'))
  const file = path.join(dir, 'cc-switch.db')
  await withCcSwitchDb(file, async () => {
    const store = new ProviderStore(dir)
    await store.load()
    assert.equal(
      store.listPublic().some((provider) => provider.kind === 'cc-switch'),
      false,
    )

    seedCcSwitchDb(file, [{ id: 'one', name: 'Gateway', current: 1 }])
    const first = await store.refreshCcSwitch()
    assert.equal(first.connected, true)
    assert.equal(first.changed, true)
    assert.equal(store.listPublic().find((p) => p.kind === 'cc-switch')?.name, 'Gateway')

    seedCcSwitchDb(file, [
      { id: 'one', name: 'Gateway', current: 1 },
      { id: 'two', name: 'Relay' },
    ])
    const second = await store.refreshCcSwitch()
    assert.equal(second.changed, true)
    assert.equal(
      store.listPublic().filter((provider) => provider.kind === 'cc-switch').length,
      2,
    )

    const same = await store.refreshCcSwitch()
    assert.equal(same.connected, true)
    assert.equal(same.changed, false)

    await unlink(file)
    const gone = await store.refreshCcSwitch()
    assert.equal(gone.connected, false)
    assert.equal(gone.changed, true)
    assert.equal(
      store.listPublic().some((provider) => provider.kind === 'cc-switch'),
      false,
    )
  })
})


test('old standalone OpenCode V2 selection falls back to the unified runtime', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deck-opencode-legacy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new ProviderStore(dir)
  await store.load()
  await store.updateRuntimeAgentBin('opencode-v2', '/opt/demo/bin/opencode-v2')
  assert.equal(store.runtimeAgentBin('opencode'), '/opt/demo/bin/opencode-v2')
  await store.updateRuntimeAgentBin('opencode', '')
  assert.equal(store.runtimeAgentBin('opencode'), '')
})

test('concurrent runtime updates preserve each independent setting', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deck-runtime-concurrent-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new ProviderStore(dir)
  await store.load()
  await Promise.all([
    store.updateRuntimeCodexBin('/opt/demo/bin/codex'),
    store.updateRuntimeAgentBin('claude', '/opt/demo/bin/claude'),
    store.updateRuntimeModelConfig({ modelContextWindow: 500_000 }),
  ])
  const reloaded = new ProviderStore(dir)
  await reloaded.load()
  assert.equal(reloaded.runtimeCodexBin(), '/opt/demo/bin/codex')
  assert.equal(reloaded.runtimeAgentBin('claude'), '/opt/demo/bin/claude')
  assert.equal(reloaded.runtimeModelConfig().modelContextWindow, 500_000)
})

test('a CC Switch read failure preserves the last successful provider snapshot', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deck-cc-recovery-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'cc-switch.db')
  seedCcSwitchDb(file, [{ id: 'demo', name: 'Demo gateway', current: 1 }])
  await withCcSwitchDb(file, async () => {
    const store = new ProviderStore(dir)
    await store.load()
    const previous = store.listPublic()
    await writeFile(file, 'invalid database')
    await assert.rejects(store.syncCcSwitch(), /could not be read/)
    assert.deepEqual(store.listPublic(), previous)
    await unlink(file)
    seedCcSwitchDb(file, [{ id: 'demo', name: 'Recovered gateway', current: 1 }])
    await store.syncCcSwitch()
    assert.equal(store.listPublic().find((p) => p.id === 'cc-demo')?.name, 'Recovered gateway')
  })
})
