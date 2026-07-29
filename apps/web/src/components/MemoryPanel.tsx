import type { MemoryOpRow } from '../lib/api.js'

/**
 * Bu taskda yaddaşın nə etdiyi (Faza 3).
 *
 * NİYƏ AYRICA GÖRÜNÜR: yaddaş işçinin promptunu dəyişir və öz xərci var.
 * Görünməsəydi, "niyə bu cavab?" və "bu pul hara getdi?" suallarının cavabı
 * gizli qalardı — eyni prinsip: routing qərarı və şablon da göstərilir.
 *
 * Əməliyyat yoxdursa panel ÜMUMİYYƏTLƏ göstərilmir: hər taskda "yaddaş: 0"
 * sətri boş səs-küydür.
 */
export default function MemoryPanel({ ops }: { ops: MemoryOpRow[] }): React.JSX.Element | null {
  if (ops.length === 0) return null

  return (
    <section className="mb-4 rounded-lg border border-white/10 bg-surface-2 p-4">
      <h2 className="mb-2 text-sm font-semibold">Yaddaş</h2>
      <table className="w-full text-left text-xs">
        <thead className="text-ink-dim">
          <tr>
            <th className="pb-2">Əməliyyat</th>
            <th className="pb-2">Sahə</th>
            <th className="pb-2">Qeyd</th>
            <th className="pb-2">Token</th>
            <th className="pb-2">Xərc</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {ops.map((op) => (
            <tr key={op.id} className="border-t border-white/5">
              <td className={`py-1.5 ${op.ok ? '' : 'text-warn'}`}>
                {op.kind}
                {!op.ok && <span className="ml-2">sındı: {op.detail ?? 'səbəb yoxdur'}</span>}
              </td>
              <td className="py-1.5">{op.scope}</td>
              <td className="py-1.5">{op.items}</td>
              <td className="py-1.5">{op.tokens}</td>
              {/* Naməlum xərc `$0` kimi göstərilmir — "pulsuz" kimi oxunardı. */}
              <td className="py-1.5">
                {op.costUsd === null ? 'bilinmir' : `$${op.costUsd.toFixed(4)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
