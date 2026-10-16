"""Browser regression test: python3 drive-sync/memory.test.py (requires Playwright/Chromium)."""
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from playwright.sync_api import sync_playwright

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(Path(__file__).resolve().parent.parent)))
Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('https://**/*', lambda r: r.abort())
        page.goto(f'http://127.0.0.1:{server.server_port}/drive-sync/', wait_until='networkidle')
        page.wait_for_function("!document.getElementById('local').disabled")
        page.evaluate('''window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('remembered-folder',{create:true});''')
        page.locator('#local').click()
        page.wait_for_function("document.getElementById('memoryStatus').textContent.includes('已記住')")
        # Simulate only the external Google UI. Storage uses real IndexedDB and a real directory handle.
        page.evaluate('''
        window.google = {accounts:{oauth2:{initTokenClient(config){return {requestAccessToken(){config.callback({access_token:'mock',expires_in:3600})}}}}}, picker:{
            ViewId:{FOLDERS:'folders'}, Action:{PICKED:'picked',CANCEL:'cancel'},
            DocsView:class {setIncludeFolders(){return this} setSelectFolderEnabled(){return this}},
            PickerBuilder:class {
                addView(){return this} setOAuthToken(){return this} setDeveloperKey(){return this}
                setAppId(){return this} setOrigin(){return this} setCallback(cb){this.cb=cb;return this}
                build(){return this} setVisible(){this.cb({action:'picked',docs:[{id:'drive-folder',name:'Remembered Drive'}]})}
            }
        }};
        window.gapi={load(name,options){options.callback()}};
        ''')
        page.locator('#login').click()
        page.locator('#remote').click()
        page.wait_for_function("!document.getElementById('remote').disabled && document.getElementById('remoteName').textContent === 'Remembered Drive'")
        page.reload(wait_until='networkidle')
        page.wait_for_function("!document.getElementById('local').disabled")
        assert 'remembered-folder' in page.locator('#localName').inner_text()
        assert 'Remembered Drive' in page.locator('#remoteName').inner_text()
        assert page.locator('#status').inner_text() == '尚未登入'
        assert not page.locator('#auto').is_checked()
        assert page.locator('#sync').is_disabled()
        # A restored handle with expired permission requires a user click.
        page.add_init_script('''FileSystemHandle.prototype.queryPermission = async () => 'prompt'; FileSystemHandle.prototype.requestPermission = async () => 'granted';''')
        page.reload(wait_until='networkidle')
        page.wait_for_function("!document.getElementById('local').disabled")
        assert page.locator('#restoreLocal').is_visible()
        page.locator('#restoreLocal').click()
        page.wait_for_function("document.getElementById('restoreLocal').hidden")
        page.locator('#forget').click()
        page.wait_for_function("document.getElementById('status').textContent.includes('已清除')")
        page.reload(wait_until='networkidle')
        page.wait_for_function("!document.getElementById('local').disabled")
        assert page.locator('#localName').inner_text() == '尚未選擇'
        assert page.locator('#remoteName').inner_text() == '尚未選擇'
        assert page.evaluate("(async()=>!!await (await navigator.storage.getDirectory()).getDirectoryHandle('remembered-folder'))()")
        assert not errors, errors
        print('PASS: persist both folder selections, restore after reload, require renewed local permission, do not restore auth or auto-sync, forget without deleting directory')
        browser.close()
finally:
    server.shutdown()
    server.server_close()
