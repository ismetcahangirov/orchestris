// models.dev/api.json-u yükləyib repoda saxlanılan snapshot-a çevirir.
//
// Niyə kəsilmiş snapshot: tam cavab 3.2 MB və 172 provayderdir. Bizə lazım
// olan üç provayderin yalnız işlətdiyimiz sahələri ~34 KB tutur. Repoda
// 3.2 MB JSON saxlamaq hər `git clone`-a və hər diff-ə düşərdi.
//
// Niyə ümumiyyətlə repoda snapshot var: models.dev əlçatan olmasa da sistem
// işləməlidir (offline). Çalışma zamanı yenisi yüklənib keşlənir, snapshot
// isə HƏMİŞƏ mövcud olan son çarədir.
//
// İşlətmək:  node scripts/fetch-models-snapshot.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://models.dev/api.json'

/**
 * Yalnız bunlar snapshot-a düşür. Yeni provayder əlavə edəndə bu siyahını
 * genişləndir və skripti yenidən işlət.
 */
const PROVIDERS = ['anthropic', 'openai', 'google']

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'server',
  'src',
  'registry',
  'models-snapshot.json',
)

/**
 * İşlətdiyimiz sahələr. Qalanı (description, knowledge, open_weights,
 * reasoning_options, temperature, family, last_updated, attachment) atılır —
 * nə router, nə qiymət hesablayıcısı, nə də UI onlara baxır.
 *
 * `cost` və onun `cache_read`/`cache_write` sahələri QƏSDƏN "yoxdursa yoxdur"
 * prinsipi ilə köçürülür: `0` yazmaq "pulsuz" deməkdir və büdcə mühafizəsini
 * yalan danışdırardı (CLAUDE.md qayda 4).
 */
function trimModel(m) {
  const out = { id: m.id, name: m.name }
  if (m.cost !== undefined) out.cost = m.cost
  if (m.limit !== undefined) out.limit = m.limit
  if (m.tool_call !== undefined) out.tool_call = m.tool_call
  if (m.structured_output !== undefined) out.structured_output = m.structured_output
  if (m.reasoning !== undefined) out.reasoning = m.reasoning
  if (m.modalities !== undefined) out.modalities = m.modalities
  if (m.release_date !== undefined) out.release_date = m.release_date
  return out
}

const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`${SOURCE} → HTTP ${res.status}`)
const all = await res.json()

const snapshot = {}
for (const id of PROVIDERS) {
  const p = all[id]
  if (p === undefined) throw new Error(`models.dev cavabında provayder yoxdur: ${id}`)
  const models = {}
  // Açarlar sıralanır: skript iki dəfə işlədiləndə diff yalnız REAL
  // dəyişikliyi göstərsin, açar sırasının dəyişməsini yox.
  for (const key of Object.keys(p.models).sort()) {
    models[key] = trimModel(p.models[key])
  }
  snapshot[id] = { id: p.id, name: p.name, env: p.env, npm: p.npm, doc: p.doc, models }
}

writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

const count = PROVIDERS.reduce((n, id) => n + Object.keys(snapshot[id].models).length, 0)
console.log(`${OUT}\n${PROVIDERS.length} provayder, ${count} model yazıldı.`)
