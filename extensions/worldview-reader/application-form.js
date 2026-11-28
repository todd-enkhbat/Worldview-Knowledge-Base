/* global chrome */
// Self-contained: runs in the chosen tab/frame, never fills or submits its form.
export function readApplicationForm(options = {}) {
  const key = '__worldviewApplicationObserver'
  if (options.stop) {
    if (window[key]?.nonce === options.stop) window[key].stop()
    return
  }
  const currentUrl = () => location.href.split('#', 1)[0]
  const pageUrl = currentUrl()
  if (options.expectedUrl && options.expectedUrl !== pageUrl) return null
  if (options.embedded && (window === window.top || window.parent !== window.top)) return null
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim()
  const sensitive = /pass(?:word|code)|security code|social security|credit card|debit card|cardholder|card number|cvv|verification code|routing number|bank account|one.time.code|cc[-_ ]|tax id/i
  const text = node => node?.innerText || node?.textContent || ''
  const visible = node => {
    for (let p = node; p; p = p.parentElement) {
      const style = getComputedStyle(p)
      if (p.hidden || p.matches('script,style,[aria-hidden="true"]') || style.display === 'none' || style.visibility === 'hidden') return false
    }
    return !!node.getClientRects().length
  }
  const labelText = node => {const copy=node.cloneNode(true);copy.querySelectorAll('input,textarea,select,button').forEach(field=>field.remove());return text(copy)}
  const answers = [], grouped = new Map()
  for (const field of document.querySelectorAll('textarea,input,select')) {
    const type = field.type || ''
    if (!visible(field) || field.disabled) continue
    const labelled = Array.from(field.labels || [], labelText).join(' ').trim() || field.getAttribute('aria-label') ||
      (field.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => text(document.getElementById(id))).filter(Boolean).join(' ')
    if (['radio','checkbox'].includes(type)) {
      const box = field.closest('fieldset,[role="group"],[role="radiogroup"]')
      const question = clean(text(box?.querySelector('legend')) || box?.getAttribute('aria-label') || field.name)
      const option = clean(labelled || field.value)
      if (question && option && !sensitive.test(question+' '+option+' '+field.name)) {
        if (!grouped.has(question)) grouped.set(question,[])
        if (field.checked) grouped.get(question).push(option)
      }
      continue
    }
    if (!['textarea','text','email','tel','number','date','url','select-one','select-multiple','search'].includes(type)) continue
    const question = clean(labelled || field.placeholder || field.name)
    if (!question || sensitive.test([question,field.name,field.id,field.autocomplete,field.placeholder].join(' '))) continue
    const instructions = (field.getAttribute('aria-describedby') || '').split(/\s+/).map(id => text(document.getElementById(id))).filter(Boolean).join('\n')
    const answer = field.tagName === 'SELECT' ? Array.from(field.selectedOptions,o=>o.value ? o.text : '').join('\n') : field.value
    answers.push({question:[question,instructions].filter(Boolean).join('\n').slice(0,8000),answer:String(answer || '').slice(0,100000)})
    if (answers.length >= 180) break
  }
  for (const [question, selected] of grouped) if (answers.length<180) answers.push({question:question.slice(0,8000),answer:selected.join('\n').slice(0,100000)})
  const title = clean(document.querySelector('meta[property="og:title"]')?.content || document.title)
  const site = clean(document.querySelector('meta[property="og:site_name"]')?.content)
  const heading = clean(text(document.querySelector('h1')))
  const opportunity = (heading || title).replace(/\s*(?:[|–—-]\s*)?(?:apply(?: now)?|application(?: form)?)\s*$/i,'').trim() || title
  const provider = /(^|\.)(?:tally\.so|typeform\.com|office\.com|google\.com)$/.test(location.hostname)
  const organization = !provider && site && !/^(?:tally|typeform|google forms|microsoft forms)$/i.test(site) ? site : opportunity
  const pageText = text(document.querySelector('main,[role="main"]') || document.body).slice(0,24000)
  const confirmation = /\b(?:your (?:application|submission|response|form) (?:has been |was |is )?(?:successfully )?(?:submitted|received|recorded)|(?:thank you|thanks) for (?:applying|submitting|completing (?:the|this|your) form|your (?:application|submission|response))|application submitted successfully)\b/i
  const acknowledgement = [...document.querySelectorAll('h1,h2,h3,[role="status"],[role="alert"]')].find(node=>visible(node)&&clean(text(node)).length<1000&&confirmation.test(text(node)))
  const providerThanks = provider && !answers.length && [...document.querySelectorAll('h1,h2,[role=heading]')].find(node=>visible(node)&&/^(?:thank you|thanks)[!.]?$/i.test(clean(text(node))))
  const submitted = !!acknowledgement || !!providerThanks || !answers.length && confirmation.test(pageText)
  const submissionEvidence = submitted ? clean(text(acknowledgement || providerThanks) || pageText).slice(0,2000) : ''
  const embeddedForms = options.embedded ? [] : [...document.querySelectorAll('iframe[src],iframe[data-tally-src]')].filter(visible).flatMap(frame=>{
    for (const attr of ['src', 'data-tally-src']) {
      const value = frame.getAttribute(attr)
      if (!value) continue
      try {
        const u = new URL(value, location.href)
        if (u.protocol !== 'https:' || u.username || u.password || u.port) continue
        const isForm = u.hostname === 'tally.so' && /^\/(?:embed|r)\/[^/]+\/?$/.test(u.pathname)
          || /(^|\.)typeform\.com$/.test(u.hostname) && /^\/to\/[^/]+\/?$/.test(u.pathname)
          || u.hostname === 'docs.google.com' && /^\/forms\/.*\/viewform\/?$/.test(u.pathname)
          || u.hostname === 'forms.office.com' && /^(?:\/Pages\/ResponsePage\.aspx|\/[er]\/[^/]+)\/?$/i.test(u.pathname)
        if (isForm) { u.hash=''; return [{url:u.href,title:frame.title || ''}] }
      } catch { /* Ignore malformed iframe URLs. */ }
    }
    return []
  }).slice(0,5)
  const result={organization,opportunity,source:location.origin+location.pathname,answers,pageText,embeddedForms,submitted,
    ...(submitted ? {submissionEvidence} : {})}
  // Armed only after this application has been saved locally. A click alone is
  // not a submission: wait for a visible acknowledgement after the submit intent.
  if (options.watch && answers.length && !submitted && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    const {nonce,applicationId,source} = options.watch
    window[key]?.stop?.()
    let pending=null, observed=null, sending=false, timer, retry
    const stop = () => {
      observer.disconnect(); clearTimeout(timer); clearTimeout(retry); clearInterval(locationCheck)
      document.removeEventListener('submit',intent,true); document.removeEventListener('click',intent,true)
      window.removeEventListener('pagehide',stop); window.removeEventListener('popstate',checkLocation)
      if (window[key]?.nonce === nonce) delete window[key]
    }
    const checkLocation = () => { if (currentUrl() !== pageUrl) stop() }
    const deliver = async () => {
      if (sending || !observed || window[key]?.nonce !== nonce) return
      sending=true
      try {
        const result=await chrome.runtime.sendMessage({type:'application-submitted',nonce,applicationId,source,form:observed})
        if (result?.ok || result?.stopped) { stop(); return }
      } catch { /* The background worker can restart between confirmation and delivery. */ }
      finally { sending=false }
      if (window[key]?.nonce === nonce) retry=setTimeout(deliver,3000)
    }
    const observe = () => {
      checkLocation()
      if (window[key]?.nonce !== nonce || !pending || observed) return
      const current=readApplicationForm()
      if (!current.submitted) return
      observed={answers:pending.answers,submitted:true,appliedAt:Date.now(),submissionEvidence:current.submissionEvidence}
      void deliver()
    }
    const intent = event => {
      const button=event.target.closest?.('button,input[type="submit"],[role="button"]')
      if (event.type!=='submit' && (!button || button.type!=='submit' || !/^(?:submit|send|apply)(?:\b|$)/i.test(clean(text(button) || button.value)))) return
      const snapshot=readApplicationForm()
      if (snapshot.submitted || !snapshot.answers.length) return
      pending=snapshot; clearTimeout(timer); timer=setTimeout(()=>{pending=null},120000)
    }
    const observer=new MutationObserver(observe)
    observer.observe(document.body,{childList:true,subtree:true,characterData:true})
    document.addEventListener('submit',intent,true); document.addEventListener('click',intent,true)
    window.addEventListener('pagehide',stop,{once:true}); window.addEventListener('popstate',checkLocation)
    const locationCheck=setInterval(checkLocation,1000)
    window[key]={nonce,stop}
    result.armed=true
  }
  return result
}

/** Combine the outer opportunity identity with readable same-tab form frames. */
export function mergeApplicationForms(outer, frames) {
  const answers=outer.answers.map(answer=>({...answer}))
  for(const form of frames) for(const answer of form.answers) {
    const old=answers.find(row=>row.question===answer.question)
    if(!old) answers.push(answer)
    else if(answer.answer) old.answer=answer.answer
  }
  const confirmation=frames.find(form=>form?.submitted)
  return {...outer,answers:answers.slice(0,180),...(confirmation ? {submitted:true,appliedAt:confirmation.appliedAt,submissionEvidence:confirmation.submissionEvidence} : {})}
}

/** Visit only visible provider embeds declared by this specific top document. */
export async function readEmbeddedApplicationForms(tabId, outer, watch) {
  if (!outer.embeddedForms.length || !chrome.webNavigation) return []
  const frameList = await chrome.webNavigation.getAllFrames({tabId}).catch(() => []) || []
  const approved = new Set(outer.embeddedForms.map(frame=>frame.url))
  const verified = frameList.filter(row=>row.parentDocumentId === outer.documentId && row.parentFrameId === 0 && row.documentLifecycle === 'active' && approved.has(row.url.split('#',1)[0]))
  const results = await Promise.allSettled(verified.map(frame=>chrome.scripting.executeScript({
    target:{tabId,documentIds:[frame.documentId]},func:readApplicationForm,
    args:[{expectedUrl:frame.url.split('#',1)[0],embedded:true,...(watch ? {watch} : {})}],
  })))
  return results.flatMap((entry,index)=>{
    if (entry.status !== 'fulfilled') return []
    const row=entry.value[0], frame=verified[index]
    if (!row?.result || row.documentId!==frame.documentId || row.frameId!==frame.frameId) return []
    return [{...row,url:frame.url.split('#',1)[0]}]
  })
}
