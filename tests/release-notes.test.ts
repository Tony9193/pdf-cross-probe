import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseReleaseLink, parseReleaseNotes } from '../src/releaseNotesParser.ts'

const sampleReleaseNotes = `## 更新内容（v1.1.6）

- **临时讲解画笔**：顶部栏支持选色、粗细、点击或拖动整笔擦除与撤销。
- **外部打开与更新可靠性**：修复慢读盘竞态与回滚清理结果分离。
- **增量搜索与内存优化**：减少大文件冗余拷贝。

## 下载与升级说明

- **v1.1.3 及以上用户可直接在「设置 → 检查更新」在线升级**。
- **v1.1.2 及更早版本请先手动下载一次**：下载 \`PDF-Cross-Probe-1.1.6-win-x64.zip\`，完整解压后运行 \`PDF Cross Probe.exe\`。
- 查看 [发布页](https://github.com/Tony9193/pdf-cross-probe/releases/tag/v1.1.6) 获取详情。
- 更新签名清单（\`update-manifest.json\`）与 \`SHA256SUMS.txt\` 不等于 Windows 代码签名。
`

test('parses release notes into headings, lists, bold and inline code', () => {
  const blocks = parseReleaseNotes(sampleReleaseNotes)
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'list', 'heading', 'list'])
  assert.equal(blocks[0].type === 'heading' && blocks[0].level, 2)
  assert.equal(blocks[1].type === 'list' && blocks[1].items.length, 3)
  assert.equal(blocks[3].type === 'list' && blocks[3].items.length, 4)

  const listText = JSON.stringify(blocks)
  assert.ok(!listText.includes('## '))
  assert.ok(!listText.includes('**'))
  assert.ok(listText.includes('"type":"strong"'))
  assert.ok(listText.includes('"type":"code","text":"PDF-Cross-Probe-1.1.6-win-x64.zip"'))
})

test('allows only repository release links and treats other URLs, code and images as plain text', () => {
  assert.equal(parseReleaseLink('https://github.com/Tony9193/pdf-cross-probe/releases/latest'), 'latest')
  assert.equal(parseReleaseLink('https://github.com/tony9193/pdf-cross-probe/releases/tag/v1.1.5'), '1.1.5')
  assert.equal(parseReleaseLink('https://github.com/Tony9193/pdf-cross-probe/releases/tag/v1.1.5?x=1'), null)
  assert.equal(parseReleaseLink('https://github.com/Tony9193/pdf-cross-probe/releases/download/v1.1.5/a.zip'), null)
  assert.equal(parseReleaseLink('https://example.com/releases/tag/v1.1.5'), null)
  assert.equal(parseReleaseLink('javascript:alert(1)'), null)

  const sample = [
    '查看 [v1.1.5](https://github.com/Tony9193/pdf-cross-probe/releases/tag/v1.1.5) 或 [最新版](https://github.com/Tony9193/pdf-cross-probe/releases/latest)',
    '忽略 [外链](https://example.com) 和 `[v1.1.5](https://github.com/Tony9193/pdf-cross-probe/releases/tag/v1.1.5)`',
    '不加载图片 ![logo](https://github.com/Tony9193/pdf-cross-probe/releases/latest) 以及 **不成对标记',
  ].join('\n\n')
  const blocks = parseReleaseNotes(sample)
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].type, 'paragraph')
  if (blocks[0].type === 'paragraph') {
    const links = blocks[0].lines[0].filter(node => node.type === 'link')
    assert.deepEqual(links, [
      { type: 'link', label: 'v1.1.5', target: '1.1.5' },
      { type: 'link', label: '最新版', target: 'latest' },
    ])
  }
  assert.equal(blocks[1].type, 'paragraph')
  if (blocks[1].type === 'paragraph') {
    assert.equal(blocks[1].lines[0].some(node => node.type === 'link'), false)
    assert.ok(blocks[1].lines[0].some(node => node.type === 'code' && node.text.includes('releases/tag/v1.1.5')))
  }
  assert.equal(blocks[2].type, 'paragraph')
  if (blocks[2].type === 'paragraph') {
    assert.equal(blocks[2].lines[0].some(node => node.type === 'link'), false)
    const joined = blocks[2].lines[0].map(node => node.type === 'text' ? node.text : '').join('')
    assert.ok(joined.includes('**不成对标记'))
    assert.ok(joined.includes('![logo]'))
  }
})
