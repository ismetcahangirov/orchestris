#!/usr/bin/env python3
"""Fixture təmizləyicisi.

Real CLI çıxışını parser testləri üçün təhlükəsiz fixture-ə çevirir:
şəxsi konfiqurasiya, yollar, session ID-lər və uzun mətnlər əvəz olunur.
Struktur (sahə adları, tiplər, iç-içə formalar) olduğu kimi qalır — parser
testinin ehtiyacı olan yalnız budur.

İstifadə:
    python fixtures/sanitize.py <giris.jsonl> <cixis.jsonl>
"""
import json
import re
import sys
import uuid

# Sabit, determinist əvəzləyicilər (testlər təkrarlana bilən olsun)
FIXED_SESSION = "00000000-0000-4000-8000-000000000001"
FIXED_CWD = "/workspace/project"
UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# Bu sahələr tamamilə əvəz olunur (şəxsi konfiqurasiya sızdıra bilər)
REDACT_FIELDS = {
    "additionalContext",
    "output",
    "stdout",
    "stderr",
    "thinking",
    "slash_commands",
    "agents",
    "mcp_servers",
    "tools",
    "skills",
    "plugins",
    "memory_paths",
}

_uuid_map: dict[str, str] = {}


def stable_uuid(original: str) -> str:
    """Hər unikal UUID-i sabit, determinist bir UUID-ə map et."""
    if original not in _uuid_map:
        n = len(_uuid_map) + 1
        _uuid_map[original] = f"00000000-0000-4000-8000-{n:012d}"
    return _uuid_map[original]


HOME_RE = re.compile(r"[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\"\s]+")


def scrub_string(s: str) -> str:
    s = UUID_RE.sub(lambda m: stable_uuid(m.group(0)), s)
    s = HOME_RE.sub("/home/user", s)
    return s


def scrub(node, key: str | None = None):
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in REDACT_FIELDS:
                if isinstance(v, list):
                    out[k] = [f"<redacted-{k}-{i}>" for i in range(len(v))]
                elif isinstance(v, str):
                    out[k] = f"<redacted-{k}:{len(v)}-chars>" if v else ""
                else:
                    out[k] = "<redacted>"
            elif k == "cwd":
                out[k] = FIXED_CWD
            else:
                out[k] = scrub(v, k)
        return out
    if isinstance(node, list):
        return [scrub(v, key) for v in node]
    if isinstance(node, str):
        return scrub_string(node)
    return node


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    kept = skipped = 0
    # utf-8-sig: PowerShell `Out-File -Encoding utf8` BOM yazır. BOM olmasa
    # ilk sətir `startswith("{")` yoxlamasından keçmir və təmizlənmədən qalır —
    # məhz o sətir (`system/init`) ən həssasıdır.
    with open(src, encoding="utf-8-sig", errors="replace") as fin, \
         open(dst, "w", encoding="utf8", newline="\n") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            if not line.startswith("{"):
                # JSON olmayan sətirlər (codex stderr logları) qəsdən saxlanılır —
                # parser onlara dözümlü olmalıdır. Amma yollar təmizlənir.
                fout.write(scrub_string(line) + "\n")
                kept += 1
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue
            fout.write(json.dumps(scrub(obj), ensure_ascii=False,
                                  separators=(",", ":")) + "\n")
            kept += 1
    # ASCII-only: Windows konsolu cp1252-dir, Azərbaycan hərfləri crash verir.
    print(f"{src} -> {dst}: {kept} lines written, {skipped} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
