const { promisify } = require('node:util')
const run = promisify(require('node:child_process').execFile)
const fs = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

async function selectedWord() {
  if(process.platform!=='darwin')return {}
  const script = `const proc=Application('System Events').applicationProcesses.whose({frontmost:true})[0];
    const result={pid:proc.unixId(),app:proc.name(),text:'',url:''};
    try {const el=proc.attributes.byName('AXFocusedUIElement').value();
      const attr=(element,name)=>{try{return element.attributes.byName(name).value()}catch{return ''}};
      if(attr(el,'AXSubrole')!=='AXSecureTextField' && attr(el,'AXRole')!=='AXSecureTextField'){
        const t=el.attributes.byName('AXSelectedText').value();if(typeof t==='string'&&t.length<=2000)result.text=t.trim()
      }
    }catch{}
    try{result.url=String(proc.windows[0].attributes.byName('AXDocument').value()||'')}catch{}
    JSON.stringify(result)`
  try {
    const {stdout}=await run('/usr/bin/osascript',['-l','JavaScript','-e',script],{timeout:1500,maxBuffer:16384})
    const result=JSON.parse(stdout)
    try{const url=new URL(result.url);result.url=['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.origin+url.pathname:''}catch{result.url=''}
    return result
  } catch {return {}}
}
async function restoreFocus(pid){
  if(!Number.isSafeInteger(pid)||pid<=0||pid===process.pid)return
  await run('/usr/bin/osascript',['-e','tell application "System Events" to set frontmost of (first application process whose unix id is '+pid+') to true'],{timeout:1000}).catch(()=>{})
}
async function recognizeRegion() {
  if (process.platform !== 'darwin') throw Error('Screen recognition requires macOS.')
  const dir = await fs.mkdtemp(join(tmpdir(), 'worldview-region-'))
  try {
    const path = join(dir, 'region.png')
    await run('/usr/sbin/screencapture', ['-i', '-x', path], { timeout: 90000 })
    await fs.access(path)
    const bundled=join(__dirname,'helper-ocr'), compiled=require('node:fs').existsSync(bundled)
    const { stdout } = await run(compiled?bundled:'/usr/bin/swift', compiled?[path]:[join(__dirname, 'helper-ocr.swift'), path], {
      timeout: 90000,
      maxBuffer: 500000
    })
    return stdout.trim()
  } catch {
    throw Error(
      'No text captured. Select a region and check Screen Recording access and the Swift command line tools.'
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
module.exports = { selectedWord, recognizeRegion, restoreFocus }
