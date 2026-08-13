import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProviderStore } from './store.js'

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
