/**
 * dsh-quant-data-mcp server 测试（node:test，零依赖）。
 *
 * 通过把 server 当作子进程拉起、用真实 NDJSON stdio 协议对话来验证：
 *   - MCP 握手（initialize）返回合法 capabilities
 *   - tools/list 返回全部 6 个工具且 schema 完整
 *   - （联网 smoke，仅 QUANT_MCP_ONLINE=1 时）quote_snapshot 真实返回行情
 *
 * 不依赖任何外部包：child_process + node:test + assert。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER = join(__dirname, '..', 'lib', 'quant-mcp-server.mjs')

const EXPECTED_TOOLS = [
  'a_share_daily',
  'quote_snapshot',
  'quote_batch',
  'financials',
  'northbound',
  'sectors',
]

/** 拉起 server，返回 { send, recv, proc }。recv 按 id 解析对应响应。 */
function startServer() {
  const proc = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, QUANT_MCP_LOG: '' },
  })
  let buf = ''
  const pending = new Map()
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  let nextId = 1
  function send(method, params) {
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, resolve)
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  return { send, proc }
}

test('initialize 返回合法 capabilities', async () => {
  const { send, proc } = startServer()
  try {
    const res = await send('initialize', { protocolVersion: '2024-11-05' })
    assert.equal(res.jsonrpc, '2.0')
    assert.ok(res.result?.capabilities?.tools, '应声明 tools capability')
    assert.equal(res.result.serverInfo.name, 'quant-mcp')
  } finally {
    proc.kill()
  }
})

test('tools/list 返回全部 6 个工具且 schema 完整', async () => {
  const { send, proc } = startServer()
  try {
    await send('initialize', { protocolVersion: '2024-11-05' })
    const res = await send('tools/list')
    const tools = res.result.tools
    assert.ok(Array.isArray(tools), 'tools 应为数组')
    assert.equal(tools.length, EXPECTED_TOOLS.length, '应有 6 个工具')
    for (const name of EXPECTED_TOOLS) {
      const t = tools.find((x) => x.name === name)
      assert.ok(t, `应存在工具 ${name}`)
      assert.ok(t.description && t.description.length > 0, `${name} 应有描述`)
      assert.ok(t.inputSchema && t.inputSchema.type === 'object', `${name} 应有 object 类型 inputSchema`)
      assert.ok(t.inputSchema.properties, `${name} 应有 properties`)
    }
  } finally {
    proc.kill()
  }
})

test('未知方法返回 Method not found', async () => {
  const { send, proc } = startServer()
  try {
    const res = await send('initialize', { protocolVersion: '2024-11-05' })
    assert.equal(res.result.serverInfo.name, 'quant-mcp')
    const bad = await send('no-such-method')
    assert.ok(bad.error, '未知方法应返回 error')
    assert.equal(bad.error.code, -32601)
  } finally {
    proc.kill()
  }
})

// 联网 smoke：仅在 QUANT_MCP_ONLINE=1 时运行，避免 CI 因外部 API 波动而 flaky。
const online = process.env.QUANT_MCP_ONLINE === '1'
test('quote_snapshot 联网返回真实行情', { skip: !online }, async () => {
  const { send, proc } = startServer()
  try {
    await send('initialize', { protocolVersion: '2024-11-05' })
    const res = await send('tools/call', {
      name: 'quote_snapshot',
      arguments: { symbol: '600000' },
    })
    assert.ok(res.result, '应有 result')
    if (res.result.isError) {
      // 网络被墙等环境原因，记为跳过而非失败
      throw new Error('skipped (network): ' + res.result.content?.[0]?.text)
    }
    const data = JSON.parse(res.result.content[0].text)
    assert.equal(data.code, '600000')
    assert.ok(typeof data.price === 'number', 'price 应为数字')
  } finally {
    proc.kill()
  }
})
