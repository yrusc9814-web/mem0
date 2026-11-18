# 可选：用真实 Chromium（Playwright）加载未打包扩展，与真实桌面端 bridge 端到端联调。
# 依赖：pip install playwright && playwright install chromium；端口 3791 需空闲。
# 用法：python3 test/independent-chromium.py
import asyncio, json, os, subprocess, sys, tempfile, shutil
from playwright.async_api import async_playwright

EXT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHAT = 'https://chatgpt.com/c/6731a2b4-0000-8000-9000-abcdefabcdef'
FIXTURE = """<!doctype html><html><head><title>E2E 测试对话</title></head><body><main>
<div data-message-author-role="user"><div class="whitespace-pre-wrap">端到端问题</div></div>
<div data-message-author-role="assistant"><div class="markdown"><p>端到端回答</p><pre><code class="language-js">1+1</code></pre></div></div>
</main></body></html>"""
results = []
def ok(name, cond, detail=''):
    results.append(('PASS' if cond else 'FAIL', name, detail)); return cond

async def main():
    helper = subprocess.Popen(['node', os.path.join(EXT, 'test', 'independent-chromium-helper.cjs')], stdout=subprocess.PIPE, text=True)
    code = json.loads(helper.stdout.readline())['code']
    state = {'last': {}}
    async def reader():
        loop = asyncio.get_event_loop()
        while True:
            line = await loop.run_in_executor(None, helper.stdout.readline)
            if not line: return
            state['last'] = json.loads(line)
    rt = asyncio.create_task(reader())
    udd = tempfile.mkdtemp()
    try:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(udd, headless=True, channel='chromium',
                args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--no-sandbox'])
            logs = []
            ctx.on('console', lambda m: logs.append((m.type, m.text)))
            ctx.on('weberror', lambda e: logs.append(('weberror', str(e.error))))
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker', timeout=15000)
            eid = sw.url.split('/')[2]
            ok('Service Worker 启动', sw.url.endswith('/src/background.js'), sw.url)
            await asyncio.sleep(1)
            st = await sw.evaluate("chrome.storage.session.get('bridge')")
            ok('未配对时状态 need_pair、徽标 !', st.get('bridge', {}).get('state') == 'need_pair' and await sw.evaluate("chrome.action.getBadgeText({})") == '!', json.dumps(st))
            popup = await ctx.new_page()
            popup.on('pageerror', lambda e: logs.append(('pageerror', str(e))))
            await popup.goto(f'chrome-extension://{eid}/src/popup/popup.html')
            await popup.wait_for_timeout(500)
            ok('弹窗渲染：9 个平台开关、配对表单可见', await popup.locator('#platforms input').count() == 9 and await popup.is_visible('#pair-form'))
            ok('弹窗自身标签页（无内容脚本）显示「不支持」', (await popup.text_content('#page-state')) == '不支持')
            await popup.fill('#code', code); await popup.click('button[type=submit]')
            await popup.wait_for_function("document.querySelector('#pair-msg').textContent !== '配对中…'", timeout=10000)
            ok('真实配对成功', (await popup.text_content('#pair-msg')) == '配对成功', await popup.text_content('#pair-msg'))
            await popup.wait_for_timeout(800)
            ok('配对后弹窗显示已连接', (await popup.text_content('#conn-state')) == '已连接', await popup.text_content('#conn-state'))
            # 伪造 chatgpt.com 页面（拦截网络，返回夹具），验证内容脚本注入 → 后台 → 桌面端入库
            reqs = []
            await ctx.route('https://chatgpt.com/**', lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=FIXTURE))
            page = await ctx.new_page()
            page.on('request', lambda r: reqs.append(r.url))
            await page.goto(CHAT)
            for _ in range(60):
                convs = state['last'].get('convs', [])
                if any(c['source'] == 'chatgpt-web' for c in convs): break
                await asyncio.sleep(0.25)
            c = next((c for c in state['last'].get('convs', []) if c['source'] == 'chatgpt-web'), None)
            ok('内容脚本 → 后台 → 桌面端：会话入库', bool(c) and c['n'] == 2 and c['first'] == '端到端问题' and c['title'] == 'E2E 测试对话', json.dumps(c, ensure_ascii=False))
            ps = await sw.evaluate("""(async () => { const [t] = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); return chrome.tabs.sendMessage(t.id, { type: 'pageStatus' }); })()""")
            ok('pageStatus：chatgpt 正在备份 2 条', ps.get('platform') == 'chatgpt' and ps.get('conversation') and ps.get('messages') == 2, json.dumps(ps))
            ok('网页侧除文档本身外无任何请求', reqs == [CHAT], json.dumps(reqs))
            q = await sw.evaluate("chrome.storage.local.get('queue')")
            ok('ack 后离线队列已清空', not (q.get('queue') or {}), json.dumps(q)[:200])
            errs = [l for l in logs if l[0] in ('error', 'pageerror', 'weberror')]
            ok('扩展页面/SW 无报错', not errs, json.dumps(errs, ensure_ascii=False)[:300])
            await ctx.close()
    finally:
        helper.kill(); shutil.rmtree(udd, ignore_errors=True)
    for s, n, d in results: print(('✓' if s == 'PASS' else '✗'), n, ('→ ' + d) if s != 'PASS' and d else '')
    print(f"PASS {sum(r[0]=='PASS' for r in results)} / {len(results)}")
    sys.exit(0 if all(r[0] == 'PASS' for r in results) else 1)

asyncio.run(main())
