import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, unlink } from 'node:fs/promises'
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
