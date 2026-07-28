# Frissítés Béla Codex Bridge 0.1.5-re

A 0.1.5 két, élő tesztben bizonyított hibát javít.

1. A 0.1.4 per-thread Béla MCP konfigurációja nem rögzítette explicit módon az
   `enabled = true` és `default_tools_approval_mode = "auto"` értékeket. A
   produkciós Codex-agent ezért úgy is végre tudott hajtani egy normál turnt,
   hogy a kötelező Béla MCP toolok nem jelentek meg.
2. A telepítő újraépítette a Marveen `dist` könyvtárát, de a
   `bela-dashboard.service` folyamatot nem indította újra. A már futó Node
   process emiatt továbbra is a build előtti kódot szolgálhatta ki.

## Javított működési szerződés

- A Béla MCP szerver explicit engedélyezett és kötelező.
- A négy kötelező tool:
  - `bela_agent_message_send`;
  - `bela_agent_message_status`;
  - `bela_memory_search`;
  - `bela_memory_get`.
- Minden run a `mcpServerStatus/list` App Server metódussal ellenőrzi a
  threadhez tartozó tényleges MCP-inventoryt.
- Hiányzó szerver vagy tool esetén a run `required_mcp_unavailable` hibával
  leáll; nem indul el eszköztelen Codex-turn.
- Az MCP startup események bekerülnek a systemd journalba.
- A `--restart-bela` külön újraindítja a dashboard service-t, majd ellenőrzi,
  hogy a process már a friss build után indult.

## Telepítés

```bash
cd ~/bela-codex-preflight

sha256sum -c Bela-Codex-Bridge-v0.1.5.tar.gz.sha256
tar -xzf Bela-Codex-Bridge-v0.1.5.tar.gz

cd bela-codex-bridge-0.1.5

./scripts/install.sh \
  --marveen-root "$HOME/marveen" \
  --restart-bela
```

A Bridge tokenje, SQLite adatbázisa, agent runtime-ja és a Marveen
agentkönyvtárai megmaradnak. A telepítő új Bridge release könyvtárat hoz létre,
majd atomikusan átállítja a `current` symlinket.

## Kötelező élő ellenőrzés

Telepítés után, idle állapotban:

1. `/readyz` és `/v1/meta`;
2. meglévő `codex` agent stop/start vagy fresh-thread;
3. egy normál E2E marker run;
4. journalban:

```text
Codex MCP server startup status
Required Béla MCP server ready
```

5. a Codex-agent hívja meg a `bela_agent_message_send`, majd a
   `bela_agent_message_status` toolt.

PASS csak akkor adható, ha a marker Béla inboxába pontosan egyszer megérkezik,
és a státuszlekérdezés ugyanennek az agentnek a saját üzenetét adja vissza.
