# @pipeworx/hk-stocks

Live Hong Kong equity market data — the full Hang Seng index family and
real-time HKEX stock quotes, with a name→code resolver that returns the actual
share rather than its warrants.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `hk_market_snapshot()` — closing level, change, change %, day range and
  52-week range for HSI (恒生指数), HSCEI (恒生中国企业指数, H-shares),
  HSTECH (恒生科技指数), HSCCI (恒生香港中资企业指数, red chips), and
  VHSI (恒指波幅指数, volatility). Answers "how did Hong Kong close".
- `hk_quote({ codes })` — real-time quotes by HKEX code. English + Chinese name,
  price, change, open/prev close, day high/low, share volume, HKD turnover, P/E,
  52-week range. Accepts `700`, `00700`, `0700.HK`, `HK:700`.
- `hk_resolve_symbol({ name })` — company name → HKEX code. Handles English and
  Chinese input.

## Auth

Keyless. Both upstreams are public and unauthenticated; no registration, no
quota to negotiate.

## Data sources

- <https://hq.sinajs.cn/list=rt_hkHSI,rt_hk00700> — index levels and equity
  quotes. **GBK-encoded, not UTF-8** — decode from raw bytes
  (`new TextDecoder('gbk')`), or every Chinese name arrives as mojibake.
- <https://suggest3.sinajs.cn/suggest/type=31&key=腾讯> — name→code for **Chinese**
  input.
- <https://query1.finance.yahoo.com/v1/finance/search?q=tencent> — name→code for
  **Latin** input.

### Things worth not rediscovering

**Neither resolver upstream covers both scripts, which is why there are two.**

- **Yahoo rejects non-ASCII outright** — `q=小米` returns HTTP 400, not an empty
  result set. It cannot answer Chinese queries at all.
- **Sina's HK suggest is a warrant index on Latin input.** `key=tencent` returns
  `TENCENT N4104`, `TENCENT N6006`, `TENCENT N3606-R` … and **never 00700**. On
  Chinese input (`key=腾讯`) the same endpoint ranks the real equity first. So
  Sina is used for CJK, Yahoo for Latin, and Yahoo-miss falls back to Sina.

**HKEX code ranges do the filtering.** Equities and GEM sit below 10000;
10000–69999 are derivative warrants and CBBCs; 80000+ are the RMB counters of
dual-counter stocks (`80700` is Tencent's RMB line, not its HKD share). Both are
plausible-looking wrong answers to "Tencent's HK code", so a single `< 10000`
threshold excludes both.

**Index turnover/volume are deliberately not returned.** Sina populates fields
11/12 as HKD turnover and share volume for equities — verifiable, since
36,203,193 shares × ~HK$462 reconciles to the HK$16.76bn turnover it reports.
On *index* rows those slots hold something else: HSI reports `312,233,275` and
`14,192,915,767`, neither of which reconciles against known HKEX daily market
turnover. Rather than relabel a number we cannot account for, the snapshot omits
it and says so. Per-stock turnover from `hk_quote` is sound.

**A missing listing returns an empty payload, not an error.** Sina answers an
unknown code with `var hq_str_rt_hk99999="";` — HTTP 200. Callers must treat an
empty field list as not-found, or a nonexistent stock silently becomes a quote
with null prices.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hk-stocks": {
      "url": "https://gateway.pipeworx.io/hk-stocks/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/hk-stocks/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/hk_market_snapshot \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/hk_market_snapshot`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "hk-stocks": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-hk-stocks"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-hk-stocks
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Hk Stocks data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
