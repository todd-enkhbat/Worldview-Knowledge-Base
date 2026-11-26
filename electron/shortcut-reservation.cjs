const { spawn } = require('node:child_process')
const { existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
function shortcutIdentity(value) {
  const parts=value.toLowerCase().split('+'), key=parts.pop()
  const masks={command:256,super:256,commandorcontrol:256,cmdorctrl:256,shift:512,option:2048,alt:2048,control:4096}
  const modifiers=parts.reduce((bits,modifier)=>bits | masks[modifier],0)
  return {key,modifiers,id:modifiers+'-'+key}
}
async function reserveShortcut(app,value) {
  const executable=join(__dirname,'helper-shortcut')
  if(process.platform!=='darwin'||!existsSync(executable))return ()=>{}
  const {key,modifiers,id}=shortcutIdentity(value)
  const dir=join(app.getPath('appData'),'Worldview Shortcut Reservations')
  mkdirSync(dir,{mode:0o700,recursive:true})
  const child=spawn(executable,[join(dir,id),key,String(modifiers)],{stdio:['pipe','pipe','ignore']})
  child.stdin.on('error',()=>{})
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(Error('Could not check the shortcut. Your existing binding is still active.'))},3000)
    child.once('error',e=>{clearTimeout(timer);reject(e)})
    child.once('exit',()=>{clearTimeout(timer);reject(Error('The shortcut is already in use or could not be reserved.'))})
    child.stdout.once('data',data=>{
      clearTimeout(timer)
      if(data.toString().trim()!=='ready'){child.stdin.end();reject(Error('That shortcut is already in use. Choose another.'));return}
      resolve(()=>child.stdin.end())
    })
  })
}
module.exports={shortcutIdentity,reserveShortcut}
